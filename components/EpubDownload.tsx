import React from 'react';

interface EpubDownloadProps {
  epubBlob: Blob | null;
  fileName: string;
}

export const EpubDownload: React.FC<EpubDownloadProps> = ({ epubBlob, fileName }) => {
  const handleDownload = () => {
    if (!epubBlob) return;
    const url = URL.createObjectURL(epubBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName}.epub`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6 text-center">
      <h2 className="text-2xl uppercase tracking-widest font-bold text-white">Conversion Complete</h2>
      <p className="text-gray-300">Your EPUB file is ready for download.</p>
      <div>
        <button
          onClick={handleDownload}
          disabled={!epubBlob}
          className="px-8 py-3 bg-white text-black font-semibold text-lg border border-white hover:bg-gray-200 focus:outline-none transition-colors duration-200 disabled:opacity-50"
        >
          Download EPUB File
        </button>
      </div>
    </div>
  );
};