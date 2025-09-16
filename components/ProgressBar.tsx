import React from 'react';

interface ProgressBarProps {
  progress: number;
  message: string;
  estimatedTime: string;
  elapsedTime: string;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({ progress, message, estimatedTime, elapsedTime }) => {
  return (
    <div className="w-full space-y-4 p-6 bg-gray-900 border border-white">
      <div className="flex justify-between items-center">
        <div className="text-left">
          <p className="text-lg text-gray-200">{message}</p>
          {estimatedTime && <p className="text-sm text-gray-400">{estimatedTime}</p>}
        </div>
        {elapsedTime && <div className="text-lg text-white font-mono">{elapsedTime}</div>}
      </div>
      <div className="w-full bg-gray-700 border border-white h-6">
        <div
          className="bg-white h-full text-black flex items-center justify-center text-xs font-bold transition-all duration-300 ease-linear"
          style={{ width: `${progress}%` }}
        >
          {progress > 10 && `${Math.round(progress)}%`}
        </div>
      </div>
    </div>
  );
};