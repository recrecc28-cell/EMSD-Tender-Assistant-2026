import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { format, subDays, parseISO, isValid } from 'date-fns';
import { FileUp, FileText, Loader2, Calendar, Edit3, Building, MapPin, User, CheckCircle2, Download } from 'lucide-react';
import { GoogleGenAI, Type } from '@google/genai';
import { PDFDocument } from 'pdf-lib';
import { saveAs } from 'file-saver';

interface ExtractedDates {
  returnByFaxDate: string | null;
  tenderClosingDate: string | null;
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = (error) => reject(error);
  });
};

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Base extracted dates
  const [dates, setDates] = useState<ExtractedDates>({
    returnByFaxDate: null,
    tenderClosingDate: null
  });

  // Derived dates
  const signatureDate = dates.returnByFaxDate && isValid(parseISO(dates.returnByFaxDate)) 
    ? format(subDays(parseISO(dates.returnByFaxDate), 2), 'yyyy-MM-dd') 
    : 'Pending Site Visit Fax Date';
    
  const quotationDate = format(new Date(), 'yyyy-MM-dd');

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    const selectedFile = acceptedFiles[0];
    if (!selectedFile) return;

    setFile(selectedFile);
    setIsUploading(true);
    setError(null);

    try {
      const base64Data = await fileToBase64(selectedFile);
      const mimeType = selectedFile.type || 'application/octet-stream';

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { data: base64Data, mimeType } },
              { text: `Analyze this EMSD tender document. We need to extract specific dates to organize the submission.
        
        Extract the following:
        1. Return By Fax Date from the 'APPLICATION FOR TENDER SITE VISIT' page (e.g. Please return by fax before [Date])
        2. Tender Closing Date / Time (截止投標時間 / 截標日期 / Tender Closing)
        
        Respond ONLY with a JSON object format. Format dates as YYYY-MM-DD. 
        If a date cannot be found, use null.` }
            ]
          }
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              returnByFaxDate: { type: Type.STRING, description: "YYYY-MM-DD format" },
              tenderClosingDate: { type: Type.STRING, description: "YYYY-MM-DD format" }
            }
          }
        }
      });

      const resultText = response.text || '{}';
      const data: ExtractedDates = JSON.parse(resultText);
      setDates(data);
    } catch (err: any) {
      console.error(err);
      const errorString = String(err);
      if (errorString.includes('API key not valid') || err?.status === 400 || err?.status === 403) {
        setError('Invalid Gemini API Key. Please configure a valid API key in the Settings > Secrets panel of AI Studio.');
      } else {
        setError(err instanceof Error ? err.message : 'An unknown error occurred');
      }
    } finally {
      setIsUploading(false);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf'],
      'application/msword': ['.doc'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx']
    },
    maxFiles: 1
  });

  const handleDateChange = (type: 'siteVisitDate' | 'tenderClosingDate', value: string) => {
    setDates(prev => ({ ...prev, [type]: value }));
  };

  const drawTextAsImage = async (pdfDoc: PDFDocument, page: any, text: string, x: number, y: number, fontSize: number = 7) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if(!ctx) return;
    
    const pxSize = fontSize * 1.3333; // pt to px exact conversion
    const scale = 4;
    ctx.font = `${pxSize * scale}px "Times New Roman", Times, serif`;
    const textMetrics = ctx.measureText(text);
    canvas.width = Math.max(textMetrics.width + (4 * scale), 1);
    canvas.height = (pxSize * 1.5 * scale);
    
    // Re-apply font after resizing canvas
    ctx.font = `${pxSize * scale}px "Times New Roman", Times, serif`;
    ctx.fillStyle = '#000000'; // Black text
    ctx.textBaseline = 'top';
    ctx.fillText(text, 2 * scale, 2 * scale);
    
    const pngUrl = canvas.toDataURL('image/png');
    const pngImage = await pdfDoc.embedPng(pngUrl);
    
    page.drawImage(pngImage, {
      x,
      y: y - 10,
      width: canvas.width / scale,
      height: canvas.height / scale,
    });
  };

  const handleDownloadPDF = async () => {
    if (!file) return;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdfDoc = await PDFDocument.load(arrayBuffer);
      const form = pdfDoc.getForm();
      const fields = form.getFields();

      let filledCount = 0;
      const fieldNames = fields.map(f => f.getName());

      // Heuristic auto-fill
      fields.forEach(field => {
        const name = field.getName().toLowerCase();
        try {
          const textField = form.getTextField(field.getName());
          let matched = false;

          if (name.includes('date') || name.includes('日期') || name.includes('dd') || name.includes('mm') || name.includes('yy')) {
            if (name.includes('visit') || name.includes('fax') || name.includes('site') || name.includes('簽名')) textField.setText(signatureDate);
            else textField.setText(quotationDate);
            matched = true;
          } else if (name.includes('on behalf') || name.includes('代表') || name.includes('behalf')) {
            textField.setText('REC Engineering Company Limited');
            matched = true;
          } else if (name.includes('company') || name.includes('firm') || name.includes('公司') || name.includes('name of com')) {
            textField.setText('REC Engineering Company Limited');
            matched = true;
          } else if (name.includes('address') || name.includes('地址')) {
            if (name.includes('company') || name.includes('visit') || name.includes('kwai')) textField.setText('Kwai Chung');
            else textField.setText('Units A-D, 15/F Goodman Kwai Chung Logistics Centre, 585-609 castle peak road, kwai chung, New Territories, Hong Kong');
            matched = true;
          } else if (name.includes('post') || name.includes('職位') || name.includes('attendee post')) {
            textField.setText('Engineer');
            matched = true;
          } else if (name.includes('name in block') || name.includes('block letters') || name.includes('mr.') || name.includes('姓名')) {
            if (name.includes('witness') || name.includes('見證')) textField.setText('陳小明');
            else textField.setText('MR ALAN CHAN');
            matched = true;
          } else if (name.includes('name') || name.includes('聯絡人') || name.includes('attendee') || name.includes('名稱')) {
            if (name.includes('2')) textField.setText('李先生');
            else textField.setText('王先生');
            matched = true;
          } else if (name.includes('tel') || name.includes('phone') || name.includes('no') || name.includes('電話')) {
            if (name.includes('2')) textField.setText('26198887');
            else textField.setText('92882982');
            matched = true;
          } else if (name.includes('status') || name.includes('capacity') || name.includes('official') || name.includes('身分')) {
            textField.setText('SENIOR MANAGER');
            matched = true;
          } else if (name.includes('style') || name.includes('類別')) {
            textField.setText('Engineering');
            matched = true;
          } else if (name.includes('occupation') || name.includes('witness occ') || name.includes('職業')) {
            textField.setText('Manager');
            matched = true;
          }

          if (matched) {
            filledCount++;
            try {
              textField.setFontSize(7);
            } catch (e) {
              // Ignore if field doesn't support setting font size
            }
          }
        } catch (e) {
          // ignore fields that aren't text fields
        }
      });

      if (fields.length === 0 || filledCount === 0) {
        // Fallback drawing for Flat PDFs directly on Page 8 and Page 39
        const pages = pdfDoc.getPages();
        
        // Page 8 (Index 7)
        if (pages.length > 7) {
          const page = pages[7];
          const { height } = page.getSize();
          
          // 7.5cm = 212.6 points
          const mmToPt = (mm: number) => mm * 2.83465;
          
          const fontSize = 7;
          
          // Table data
          await drawTextAsImage(pdfDoc, page, `REC Engineering Company Limited`, mmToPt(130), height - mmToPt(121), fontSize);
          
          await drawTextAsImage(pdfDoc, page, `Units A-D, 15/F Goodman Kwai Chung Logistics Centre,`, mmToPt(130), height - mmToPt(125), 6);
          await drawTextAsImage(pdfDoc, page, `585-609 castle peak road, kwai chung, New Territories, Hong Kong`, mmToPt(130), height - mmToPt(128), 6);
          
          // Row 1
          await drawTextAsImage(pdfDoc, page, `王先生`, mmToPt(130), height - mmToPt(135), fontSize);
          await drawTextAsImage(pdfDoc, page, `92882982`, mmToPt(130), height - mmToPt(144), fontSize);
          await drawTextAsImage(pdfDoc, page, `Engineer`, mmToPt(130), height - mmToPt(139), fontSize);
          
          // Row 2
          await drawTextAsImage(pdfDoc, page, `李先生`, mmToPt(155), height - mmToPt(135), fontSize);
          await drawTextAsImage(pdfDoc, page, `26198887`, mmToPt(155), height - mmToPt(144), fontSize);
          await drawTextAsImage(pdfDoc, page, `Engineer`, mmToPt(155), height - mmToPt(139), fontSize);
          
          // Signature Block
          await drawTextAsImage(pdfDoc, page, `王先生`, mmToPt(120), height - mmToPt(173), fontSize);
          await drawTextAsImage(pdfDoc, page, signatureDate, mmToPt(120), height - mmToPt(181), fontSize);
          await drawTextAsImage(pdfDoc, page, `REC Engineering Company Limited`, mmToPt(120), height - mmToPt(190), fontSize);
        }

        // Page 39 (Index 38)
        if (pages.length > 38) {
          const page = pages[38];
          const { height } = page.getSize();
          
          const mmToPt = (mm: number) => mm * 2.83465;
          const fontSize = 7;
          await drawTextAsImage(pdfDoc, page, `SENIOR MANAGER`, mmToPt(143), height - mmToPt(243), fontSize);
          await drawTextAsImage(pdfDoc, page, `MR ALAN CHAN`, mmToPt(70), height - mmToPt(260), fontSize);
          await drawTextAsImage(pdfDoc, page, quotationDate, mmToPt(145), height - mmToPt(260), fontSize);
        }

        alert("This PDF lacked interactive fields, so we successfully drew your information directly onto Page 8 and Page 39 in black Times New Roman.");
      } else {
        alert(`Successfully filled ${filledCount} out of ${fields.length} interactive fields!`);
        form.flatten(); // Flatten form so it's not editable anymore
      }

      const pdfBytes = await pdfDoc.save();
      saveAs(new Blob([pdfBytes], { type: 'application/pdf' }), `filled_${file.name}`);
    } catch (err) {
      console.error(err);
      alert("Failed to process PDF for download.");
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <header className="bg-white border-b border-slate-200 py-6 px-4 md:px-8 shadow-sm">
        <div className="max-w-5xl mx-auto flex items-center space-x-3">
          <div className="p-2 bg-emerald-600 rounded-lg">
            <FileText className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-800">EMSD Tender Assistant 2026</h1>
            <p className="text-sm text-slate-500">Auto-fill your Site Visit & Quotation forms securely.</p>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8 space-y-8">
        
        {/* Top Controls Row: Upload and Download */}
        <div className="flex flex-col gap-6 items-center max-w-md mx-auto w-full">
          
          {/* Upload Section */}
          <section className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 w-full flex flex-col">
            <div 
              {...getRootProps()} 
              className={`border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center text-center cursor-pointer transition-colors duration-200 flex-grow
                ${isDragActive ? 'border-emerald-500 bg-emerald-50' : 'border-slate-300 hover:bg-slate-50 hover:border-emerald-400 bg-slate-50/50'}`}
            >
              <input {...getInputProps()} />
              {isUploading ? (
                <>
                  <Loader2 className="w-8 h-8 text-emerald-500 animate-spin mb-3" />
                  <p className="text-sm font-medium text-slate-700">Analyzing...</p>
                </>
              ) : (
                <>
                  <div className="p-3 bg-white shadow-sm ring-1 ring-slate-900/5 rounded-full mb-3">
                    <FileUp className="w-6 h-6 text-emerald-600" />
                  </div>
                  <p className="text-sm font-medium text-slate-700">Drag & drop document</p>
                  <p className="text-xs text-slate-500 mt-2">
                    PDF or Word format
                  </p>
                  {file && (
                    <div className="mt-4 flex items-center space-x-1.5 text-xs text-emerald-600 font-medium bg-emerald-50 px-2.5 py-1 rounded-full w-full justify-center">
                      <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                      <span className="truncate">{file.name}</span>
                    </div>
                  )}
                </>
              )}
            </div>
            
            {error && (
              <div className="mt-3 p-3 bg-red-50 text-red-700 rounded-lg text-xs border border-red-100 flex items-start space-x-2">
                <span className="font-semibold px-1.5 py-0.5 bg-red-100 rounded">Error</span>
                <span>{error}</span>
              </div>
            )}
          </section>

          {/* Download Section */}
          {file && !isUploading && (
            <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 w-full flex flex-col items-center justify-center text-center">
               <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mb-4">
                 <Download className="w-8 h-8 text-emerald-600" />
               </div>
               <h3 className="text-lg font-semibold text-slate-800 mb-2">Ready to Download</h3>
               <button
                 onClick={handleDownloadPDF}
                 className="flex items-center justify-center space-x-2 bg-emerald-600 hover:bg-emerald-700 text-white px-8 py-3 rounded-xl font-medium transition-colors shadow-sm w-full"
               >
                 <Download className="w-5 h-5" />
                 <span>Download Filled Form</span>
               </button>
            </section>
          )}

        </div>

        {/* Form Outputs */}
        <div className="grid md:grid-cols-2 gap-6 items-start">
          
          {/* Site Visit Application Form */}
          <section className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="bg-slate-50 px-6 py-4 border-b border-slate-200">
              <h3 className="text-lg font-semibold text-slate-800">Appendix NTT.A APPLICATION FOR TENDER SITE VISIT</h3>
              <p className="text-sm text-slate-500">Calculated Signature Date: Fax Deadline - 2 Days</p>
            </div>
            <div className="p-6 space-y-4 text-sm text-slate-700">
              <div className="grid grid-cols-[140px_1fr] gap-2 items-start border-b border-slate-100 pb-3">
                <span className="font-medium flex items-center gap-1.5 text-slate-500"><Building className="w-3.5 h-3.5"/> Name of Company</span>
                <span className="font-medium text-slate-900">REC Engineering Company Limited</span>
              </div>
              <div className="grid grid-cols-[140px_1fr] gap-2 items-start border-b border-slate-100 pb-3">
                <span className="font-medium flex items-center gap-1.5 text-slate-500"><MapPin className="w-3.5 h-3.5"/> Address of Company</span>
                <span className="leading-snug">Units A-D, 15/F Goodman Kwai Chung Logistics Centre, 585-609 castle peak road, kwai chung, New Territories, Hong Kong</span>
              </div>
              <div className="grid grid-cols-[130px_1fr] gap-2 items-start border-b border-slate-100 pb-3">
                <span className="font-medium text-slate-500">Name1</span>
                <span>王先生 <span className="text-slate-400 mx-1">|</span> Tel No: 92882982</span>
              </div>
              <div className="grid grid-cols-[130px_1fr] gap-2 items-start border-b border-slate-100 pb-3">
                <span className="font-medium text-slate-500">Name2</span>
                <span>李先生 <span className="text-slate-400 mx-1">|</span> Tel No: 26198887</span>
              </div>
              <div className="grid grid-cols-[130px_1fr] gap-2 items-start border-b border-slate-100 pb-3">
                <span className="font-medium text-slate-500">Post</span>
                <span>Engineer, Engineer</span>
              </div>
              <div className="grid grid-cols-[130px_1fr] gap-2 items-start border-b border-slate-100 pb-3">
                <span className="font-medium flex items-center gap-1.5 text-slate-500"><User className="w-3.5 h-3.5"/> Name</span>
                <span>王先生</span>
              </div>
              <div className="grid grid-cols-[130px_1fr] gap-2 items-start border-b border-slate-100 pb-3">
                <span className="font-medium flex items-center gap-1.5 text-slate-500"><Building className="w-3.5 h-3.5"/> Company Name</span>
                <span className="font-medium text-slate-900">REC Engineering Company Limited</span>
              </div>
              <div className="grid grid-cols-[130px_1fr] gap-2 items-start pt-1">
                <span className="font-medium flex items-center gap-1.5 text-slate-500"><Calendar className="w-3.5 h-3.5"/> 簽名日期</span>
                <span className={`font-semibold ${dates.returnByFaxDate ? 'text-emerald-700' : 'text-amber-600'}`}>
                  {signatureDate}
                </span>
              </div>
            </div>
          </section>

          {/* Form of Quotation */}
          <section className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
             <div className="bg-slate-50 px-6 py-4 border-b border-slate-200">
               <h3 className="text-lg font-semibold text-slate-800">Form of Quotation(Engineering)</h3>
               <p className="text-sm text-slate-500">Calculated Date: Today</p>
             </div>
             <div className="p-6 space-y-4 text-sm text-slate-700">
               <div className="grid grid-cols-[150px_1fr] gap-2 items-start border-b border-slate-100 pb-3">
                 <span className="font-medium text-slate-500">Offical Status</span>
                 <span>SENIOR MANAGER</span>
               </div>
               <div className="grid grid-cols-[150px_1fr] gap-2 items-start border-b border-slate-100 pb-3">
                 <span className="font-medium flex items-center gap-1.5 text-slate-500"><User className="w-3.5 h-3.5"/> Name in Block Letters</span>
                 <span className="uppercase text-slate-900 font-medium">MR ALAN CHAN</span>
               </div>
               <div className="grid grid-cols-[150px_1fr] gap-2 items-start pt-1">
                 <span className="font-medium flex items-center gap-1.5 text-slate-500"><Calendar className="w-3.5 h-3.5"/> Date</span>
                 <span className={`font-semibold text-emerald-700`}>
                   {quotationDate}
                 </span>
               </div>
             </div>
          </section>

        </div>
      </main>
    </div>
  );
}
