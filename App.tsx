import React, { useState, useEffect, useRef } from 'react';
import { FileUpload } from './components/FileUpload';
import { ProgressBar } from './components/ProgressBar';
import { EpubDownload } from './components/EpubDownload';
import { 
  startEpubConversionChat, 
  sendPdfChunkToChat, 
  finishEpubConversionChat 
} from './services/geminiService';
import { generateEpub } from './services/epubService';

const CHUNK_SIZE = 5; // Process 5 pages at a time
const THROTTLE_MS = 1500; // Increased to 1.5s for a safer request rate (40 RPM)

const formatTime = (ms: number): string => {
    if (ms < 0) return '';
    const seconds = Math.round(ms / 1000);
    if (seconds < 5) return 'a few seconds remaining';
    if (seconds < 60) return `less than a minute remaining`;
    const minutes = Math.ceil(seconds / 60);
    if (minutes === 1) return `about 1 minute remaining`;
    return `about ${minutes} minutes remaining`;
};

const formatElapsedTime = (ms: number): string => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
};


const App: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadingMessage, setLoadingMessage] = useState<string>('');
  const [epubBlob, setEpubBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string>('');
  const [progress, setProgress] = useState<number>(0);
  const [estimatedTime, setEstimatedTime] = useState<string>('');
  const [elapsedTime, setElapsedTime] = useState<string>('');
  const [resumableSession, setResumableSession] = useState<any | null>(null);
  const [isRetriableError, setIsRetriableError] = useState<boolean>(false);
  const timerIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (file) {
      const sessionKey = `epub-session-${file.name}-${file.size}`;
      const savedSession = localStorage.getItem(sessionKey);
      if (savedSession) {
        try {
          const parsed = JSON.parse(savedSession);
          if (parsed.currentChunk && parsed.chatHistory) {
            setResumableSession(parsed);
          } else {
            throw new Error("Invalid session data");
          }
        } catch (e) {
          console.error("Failed to parse saved session, clearing it.", e);
          localStorage.removeItem(sessionKey);
          setResumableSession(null);
        }
      } else {
        setResumableSession(null);
      }
    } else {
        setResumableSession(null);
    }
  }, [file]);
  
  // Cleanup timer on component unmount
  useEffect(() => {
    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
    };
  }, []);


  const handleFileSelect = (selectedFile: File) => {
    setFile(selectedFile);
    setEpubBlob(null);
    setError('');
    setIsRetriableError(false);
    setElapsedTime('');
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
    }
  };

  const handleStartOver = () => {
    if (!file) return;
    const sessionKey = `epub-session-${file.name}-${file.size}`;
    localStorage.removeItem(sessionKey);
    setResumableSession(null);
    setIsRetriableError(false);
    handleConvert(true); // Force a new conversion
  };

  const handleConvert = async (forceNew: boolean = false) => {
    if (!file) {
      setError('Please select a PDF file first.');
      return;
    }

    const sessionKey = `epub-session-${file.name}-${file.size}`;
    let shouldResume = resumableSession && !forceNew;
    
    if (shouldResume && !isRetriableError) { // Don't confirm on retry
        if (!window.confirm('An unfinished session was found for this file. Do you want to resume from where you left off?')) {
            shouldResume = false;
        }
    }

    setIsLoading(true);
    setError('');
    setIsRetriableError(false);
    setEpubBlob(null);
    setProgress(0);
    setEstimatedTime('');
    setElapsedTime('');
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
    }

    const startTime = Date.now();
    timerIntervalRef.current = window.setInterval(() => {
        setElapsedTime(formatElapsedTime(Date.now() - startTime));
    }, 1000);

    try {
      setLoadingMessage('Loading PDF file...');
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await (window as any).pdfjsLib.getDocument(arrayBuffer).promise;
      const numPages = pdf.numPages;

      let chat;
      let resumeFromChunk = 0;
      let allImages: { mimeType: string; data: string }[] = [];

      if (shouldResume && resumableSession) {
        setLoadingMessage('Resuming previous session...');
        chat = await startEpubConversionChat(resumableSession.chatHistory);
        resumeFromChunk = resumableSession.currentChunk;
        allImages = resumableSession.allImages || [];
        console.log(`Resuming conversion from chunk ${resumeFromChunk}`);
      } else {
        localStorage.removeItem(sessionKey); // Clear any old session if starting new
        setLoadingMessage('Initializing AI conversion...');
        chat = await startEpubConversionChat();
      }

      const numChunks = Math.ceil(numPages / CHUNK_SIZE);

      const PDF_PROCESSING_WEIGHT = 0.8;
      const AI_PROCESSING_WEIGHT = 0.15;

      for (let i = resumeFromChunk; i < numChunks; i++) {
        const startPage = i * CHUNK_SIZE + 1;
        const endPage = Math.min((i + 1) * CHUNK_SIZE, numPages);
        
        let chunkText = '';
        const chunkImages: { mimeType: string; data: string }[] = [];

        for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
          const currentPageProgress = ((pageNum / numPages) * PDF_PROCESSING_WEIGHT) * 100;
          setProgress(currentPageProgress);
          setLoadingMessage(`Processing page ${pageNum} of ${numPages}...`);

          const elapsedTimeSinceStart = Date.now() - startTime;
          const timePerItem = elapsedTimeSinceStart / (pageNum - (resumeFromChunk * CHUNK_SIZE));
          const remainingItems = numPages - pageNum;
          const estimatedRemainingTime = remainingItems * timePerItem;
          setEstimatedTime(formatTime(estimatedRemainingTime));

          const page = await pdf.getPage(pageNum);
          const textContent = await page.getTextContent();
          const pageText = textContent.items.map((item: any) => item.str).join('\n');
          chunkText += `\n\n--- PAGE ${pageNum} ---\n\n${pageText}`;

          const operatorList = await page.getOperatorList();
          const fns = operatorList.fnArray;
          const args = operatorList.argsArray;

          for (let j = 0; j < fns.length; j++) {
            if (fns[j] === (window as any).pdfjsLib.OPS.paintImageXObject) {
              const imageName = args[j][0];
              try {
                const img = await page.commonObjs.get(imageName);
                if (img) {
                  const canvas = document.createElement('canvas');
                  canvas.width = img.width;
                  canvas.height = img.height;
                  const ctx = canvas.getContext('2d');
                  if (ctx) {
                    const imageData = ctx.createImageData(img.width, img.height);
                     if (img.data.length === img.width * img.height * 3) {
                      let k = 0;
                      for(let l = 0; l < img.data.length; l += 3) {
                        imageData.data[k++] = img.data[l];
                        imageData.data[k++] = img.data[l+1];
                        imageData.data[k++] = img.data[l+2];
                        imageData.data[k++] = 255;
                      }
                    } else if (img.data.length === img.width * img.height * 4) {
                        imageData.data.set(img.data);
                    } else {
                        let k = 0;
                        for(let l = 0; l < img.data.length; l++) {
                            imageData.data[k++] = img.data[l];
                            imageData.data[k++] = img.data[l];
                            imageData.data[k++] = img.data[l];
                            imageData.data[k++] = 255;
                        }
                    }
                    ctx.putImageData(imageData, 0, 0);
                    const mimeType = 'image/png';
                    const base64Data = canvas.toDataURL(mimeType).split(',')[1];
                    const imageDataObj = { mimeType, data: base64Data };
                    allImages.push(imageDataObj);
                    chunkImages.push(imageDataObj);
                    chunkText += `\n[IMAGE_${allImages.length - 1}]\n`;
                  }
                }
              } catch (e) {
                console.warn(`Could not parse image ${imageName} on page ${pageNum}:`, e);
              }
            }
          }
        }
        
        const aiProgress = (PDF_PROCESSING_WEIGHT + ((i + 1) / numChunks) * AI_PROCESSING_WEIGHT) * 100;
        setProgress(aiProgress);
        setLoadingMessage(`Sending chunk ${i + 1} of ${numChunks} to AI...`);
        setEstimatedTime('This may take a minute...');

        // Save session *before* the potentially failing API call
        const historyForSave = await chat.getHistory();
        const sessionDataToSave = {
          currentChunk: i, // Save the current chunk index to retry it
          numPages: numPages,
          chatHistory: historyForSave,
          allImages: allImages,
        };
        localStorage.setItem(sessionKey, JSON.stringify(sessionDataToSave));

        await sendPdfChunkToChat(chat, chunkText, chunkImages, startPage, endPage);

        // Update session *after* the successful API call
        const historyAfterSuccess = await chat.getHistory();
        const sessionDataAfterSuccess = {
            currentChunk: i + 1,
            numPages: numPages,
            chatHistory: historyAfterSuccess,
            allImages: allImages,
        };
        localStorage.setItem(sessionKey, JSON.stringify(sessionDataAfterSuccess));
        
        await new Promise(resolve => setTimeout(resolve, THROTTLE_MS));
      }
      
      setProgress(95);
      setLoadingMessage('Asking AI to assemble the final document...');
      setEstimatedTime('Almost done...');
      const generatedHtml = await finishEpubConversionChat(chat);
      
      setProgress(98);
      setLoadingMessage('Packaging EPUB file...');
      
      const epub = await generateEpub(generatedHtml, file.name.replace(/\.pdf$/i, ''));
      setEpubBlob(epub);
      localStorage.removeItem(sessionKey); // Clean up on success
      setProgress(100);

    } catch (err: any) {
      console.error('Conversion failed:', err);
      const errorString = (typeof err === 'object' ? JSON.stringify(err) : String(err)).toLowerCase();

      if (errorString.includes("daily limit") || errorString.includes("quota exceeded")) {
        setError('Daily API quota exceeded. Your progress has been saved. Please try resuming the conversion again tomorrow.');
      } else if (errorString.includes('429') || errorString.includes('resource_exhausted')) {
        setError('API Rate Limit Exceeded. Your progress has been saved. Please wait a few minutes before resuming the conversion.');
      } else if (errorString.includes('500') || errorString.includes('503') || errorString.includes('unknown') || errorString.includes('rpc failed')) {
        setError('A temporary network or server error occurred. Your progress has been saved. Please try resuming the conversion in a moment.');
        setIsRetriableError(true);
      } else {
        setError(`An error occurred: ${err.message || 'Unknown error'}`);
      }
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 lg:p-8 bg-black text-white">
      <div className="w-full max-w-3xl mx-auto bg-black p-8 sm:p-12 border border-white">
        <header className="text-center mb-8 border-b border-white pb-6 relative">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-wider uppercase">
            PDF to EPUB Converter
          </h1>
          <p className="mt-4 text-lg text-gray-300">
            A utility for converting PDF files into reflowable EPUB documents.
          </p>
        </header>

        <main className="space-y-8">
          <FileUpload onFileSelect={handleFileSelect} disabled={isLoading} />
          
          <div className="flex justify-center items-center space-x-4">
            {isRetriableError && !isLoading ? (
              <button
                onClick={() => handleConvert()}
                className="px-10 py-4 bg-yellow-500 text-black font-semibold text-lg border border-yellow-500 hover:bg-yellow-400 focus:outline-none transition-colors duration-200"
              >
                Retry Conversion
              </button>
            ) : (
              <>
                <button
                  onClick={() => handleConvert()}
                  disabled={!file || isLoading}
                  className="px-10 py-4 bg-white text-black font-semibold text-lg border border-white hover:bg-gray-200 focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed disabled:bg-gray-600 disabled:border-gray-600 disabled:text-gray-300 transition-colors duration-200"
                >
                  {isLoading ? 'Converting...' : resumableSession ? 'Resume Conversion' : 'Convert File'}
                </button>
                {resumableSession && !isLoading && (
                  <button
                    onClick={handleStartOver}
                    className="px-6 py-2 bg-transparent text-white font-semibold text-sm border border-white hover:bg-white hover:text-black focus:outline-none transition-colors duration-200"
                  >
                    Start Over
                  </button>
                )}
              </>
            )}
          </div>

          {error && <div className="text-center text-red-400 border border-red-400 bg-red-900/20 p-3">{error}</div>}

          {isLoading && <ProgressBar progress={progress} message={loadingMessage} estimatedTime={estimatedTime} elapsedTime={elapsedTime} />}
          
          {epubBlob && !isLoading && <EpubDownload epubBlob={epubBlob} fileName={file?.name.replace(/\.pdf$/i, '') || 'document'} />}
        </main>

        <footer className="text-center mt-10 pt-6 border-t border-white text-gray-400 text-sm">
          <p>Powered by pdf.js and Google Gemini</p>
        </footer>
      </div>
    </div>
  );
};

export default App;