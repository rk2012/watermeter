import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import { motion } from 'motion/react';
import { Camera, Upload, Loader2, CheckCircle2, AlertCircle, RefreshCcw, Droplets, Save, FileCheck, X, Play, Check } from 'lucide-react';
import { analyzeMeterImage, MeterData } from '../services/gemini';
import { cn } from '../lib/utils';

export default function MeterReader() {
  const [image, setImage] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<MeterData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Access Control State
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [accessKey, setAccessKey] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Logging State
  const [isLogging, setIsLogging] = useState(false);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const [batchResults, setBatchResults] = useState<{name: string, status: 'success' | 'error', message?: string}[]>([]);
  const [logSuccess, setLogSuccess] = useState(false);

  // Camera State
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    // Check local storage for saved key
    const savedKey = localStorage.getItem('aqua_access_key');
    if (savedKey) {
      setAccessKey(savedKey);
      // Verify the saved key
      verifyKey(savedKey);
    } else {
      // Check initial auth status (cookie fallback)
      fetch('/api/auth/status', { credentials: 'include' })
        .then(res => res.json())
        .then(data => {
          setIsAuthorized(data.authorized);
        });
    }
  }, []);

  const verifyKey = async (keyToVerify: string) => {
    setIsVerifying(true);
    setAuthError(null);
    try {
      const res = await fetch('/api/auth/verify-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: keyToVerify }),
        credentials: 'include'
      });
      if (res.ok) {
        setIsAuthorized(true);
        setAccessKey(keyToVerify); // Ensure state is updated
        localStorage.setItem('aqua_access_key', keyToVerify);
      } else {
        setAuthError('Invalid access key');
        localStorage.removeItem('aqua_access_key');
      }
    } catch (err) {
      setAuthError('Connection error');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleVerifyKey = async (e: React.FormEvent) => {
    e.preventDefault();
    await verifyKey(accessKey);
  };

  const handleAnalyze = async () => {
    if (!image) return;

    setIsAnalyzing(true);
    setError(null);
    setLogSuccess(false);
    try {
      const data = await analyzeMeterImage(image);
      setResult(data);
      
      // Automatically log to backend
      await handleLogToBackend(data);
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const processBatch = async () => {
    setIsAnalyzing(true);
    setError(null);
    
    for (let i = 0; i < batchFiles.length; i++) {
      const file = batchFiles[i];
      setBatchProgress(prev => ({ ...prev, current: i + 1 }));
      
      try {
        // 1. Convert file to base64
        const base64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(file);
        });

        // 2. Analyze with Gemini
        const data = await analyzeMeterImage(base64);
        
        // 3. Log to Backend
        await handleLogToBackend(data, base64);
        
        setBatchResults(prev => [...prev, { name: file.name, status: 'success' }]);
      } catch (err: any) {
        console.error(`Error processing ${file.name}:`, err);
        setBatchResults(prev => [...prev, { name: file.name, status: 'error', message: err.message }]);
      }
    }
    
    setIsAnalyzing(false);
  };

  const handleLogToBackend = async (data: MeterData, customImage?: string) => {
    const imageToUse = customImage || image;
    if (!imageToUse) return;

    setIsLogging(true);
    try {
      console.log('[FRONTEND] Starting log to backend process...');
      // Ensure we have the access key (fallback to localStorage if state is lost)
      const currentKey = accessKey || localStorage.getItem('aqua_access_key') || '';
      
      // Resize image before sending to reduce payload size and avoid proxy-level errors
      console.log('[FRONTEND] Resizing image...');
      const resizedImageBase64 = await resizeImage(imageToUse);
      
      // Convert base64 to Blob for FormData
      console.log('[FRONTEND] Converting to blob...');
      const response = await fetch(resizedImageBase64);
      const blob = await response.blob();

      const formData = new FormData();
      formData.append('reading', data.reading);
      formData.append('label', data.label);
      formData.append('image', blob, 'meter.jpg');

      console.log('[FRONTEND] Sending request to /api/meter/log...');
      const res = await fetch('/api/meter/log', {
        method: 'POST',
        headers: {
          'X-Access-Key': currentKey
        },
        body: formData,
        credentials: 'include'
      });

      if (!res.ok) {
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const errorData = await res.json();
          throw new Error(errorData.error || 'Failed to log to backend');
        } else {
          const text = await res.text();
          console.error('[FRONTEND] Non-JSON error response:', text);
          throw new Error(`Server Error (${res.status}): The server returned an unexpected response format.`);
        }
      }

      console.log('[FRONTEND] Log successful!');
      if (!isBatchMode) setLogSuccess(true);
    } catch (err: any) {
      console.error('[FRONTEND] Logging Error:', err);
      if (!isBatchMode) setError(`Logging Error: ${err.message}`);
      throw err;
    } finally {
      setIsLogging(false);
    }
  };

  const resizeImage = (base64Str: string, maxWidth = 1024, maxHeight = 1024): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.src = base64Str;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxWidth) {
            height *= maxWidth / width;
            width = maxWidth;
          }
        } else {
          if (height > maxHeight) {
            width *= maxHeight / height;
            height = maxHeight;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        // Lower quality to 0.6 to further reduce payload size
        resolve(canvas.toDataURL('image/jpeg', 0.6));
      };
    });
  };

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;
    
    if (acceptedFiles.length > 1 || isBatchMode) {
      setIsBatchMode(true);
      setBatchFiles(acceptedFiles);
      setBatchResults([]);
      setBatchProgress({ current: 0, total: acceptedFiles.length });
      setImage(null);
      setResult(null);
    } else {
      const file = acceptedFiles[0];
      const reader = new FileReader();
      reader.onload = () => {
        setImage(reader.result as string);
        setResult(null);
        setError(null);
        setLogSuccess(false);
      };
      reader.readAsDataURL(file);
    }
  }, [isBatchMode]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/*': [] },
    multiple: true
  });

  const reset = () => {
    setImage(null);
    setResult(null);
    setError(null);
    stopCamera();
  };

  const startCamera = async () => {
    setIsCameraOpen(true);
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment' } // Prefer back camera on mobile
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        streamRef.current = stream;
      }
    } catch (err) {
      setError('Could not access camera. Please check permissions.');
      setIsCameraOpen(false);
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setIsCameraOpen(false);
  };

  const capturePhoto = () => {
    if (videoRef.current) {
      const canvas = document.createElement('canvas');
      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(videoRef.current, 0, 0);
      
      const dataUrl = canvas.toDataURL('image/jpeg');
      setImage(dataUrl);
      stopCamera();
    }
  };

  if (!isAuthorized) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white rounded-2xl border border-zinc-200 shadow-xl p-8 space-y-6">
          <div className="flex flex-col items-center text-center space-y-2">
            <div className="p-3 bg-blue-600 rounded-xl text-white mb-2">
              <Droplets size={32} />
            </div>
            <h1 className="text-2xl font-bold text-zinc-900">AquaScan Access</h1>
            <p className="text-sm text-zinc-500">Please enter your access key to continue.</p>
          </div>

          <form onSubmit={handleVerifyKey} className="space-y-4">
            <div className="space-y-2">
              <input
                type="password"
                placeholder="Enter Access Key"
                value={accessKey}
                onChange={(e) => setAccessKey(e.target.value)}
                className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all"
                autoFocus
              />
              {authError && <p className="text-xs text-red-500 font-medium pl-1">{authError}</p>}
            </div>
            <button
              type="submit"
              disabled={isVerifying || !accessKey}
              className="w-full py-3 bg-zinc-900 text-white rounded-xl font-semibold hover:bg-zinc-800 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
            >
              {isVerifying ? <Loader2 className="animate-spin" size={18} /> : 'Unlock Scanner'}
            </button>
          </form>
          
          <p className="text-[10px] text-center text-zinc-400 uppercase tracking-widest">
            AquaScan v1.0.4 // Restricted Access
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-200 pb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-600 rounded-lg text-white">
            <Droplets size={24} />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-zinc-900">AquaScan</h1>
            <p className="text-sm text-zinc-500 font-medium uppercase tracking-wider">Water Meter Intelligence</p>
          </div>
        </div>
        <div className="text-right hidden sm:block">
          <p className="text-xs font-mono text-zinc-400">v1.0.4 // VISION_ENABLED</p>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Left Column: Upload & Preview */}
        <div className="space-y-4">
          {!image && !isCameraOpen && !isBatchMode ? (
            <div className="space-y-4">
              <div
                {...getRootProps()}
                className={cn(
                  "border-2 border-dashed rounded-2xl p-12 transition-all cursor-pointer flex flex-col items-center justify-center gap-4 min-h-[300px]",
                  isDragActive ? "border-blue-500 bg-blue-50" : "border-zinc-200 hover:border-zinc-300 bg-zinc-50"
                )}
              >
                <input {...getInputProps()} />
                <div className="p-4 bg-white rounded-full shadow-sm border border-zinc-100">
                  <Upload className="text-zinc-400" size={32} />
                </div>
                <div className="text-center">
                  <p className="font-semibold text-zinc-900">
                    {isDragActive ? "Drop images here" : "Upload meter images"}
                  </p>
                  <p className="text-sm text-zinc-500 mt-1">
                    Drag and drop one or many images, or click to browse
                  </p>
                </div>
              </div>

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-zinc-200" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-zinc-50 px-2 text-zinc-400 font-mono">OR</span>
                </div>
              </div>

              <button
                onClick={startCamera}
                className="w-full py-4 bg-zinc-900 hover:bg-zinc-800 text-white rounded-xl font-semibold transition-all flex items-center justify-center gap-2 shadow-lg"
              >
                <Camera size={20} />
                Use Device Camera
              </button>
            </div>
          ) : isCameraOpen ? (
            <div className="relative rounded-2xl overflow-hidden border border-zinc-200 bg-black shadow-xl aspect-[3/4] flex items-center justify-center">
              <video 
                ref={videoRef} 
                autoPlay 
                playsInline 
                className="w-full h-full object-cover"
              />
              <div className="absolute bottom-6 inset-x-0 flex justify-center items-center gap-6">
                <button
                  onClick={stopCamera}
                  className="p-4 bg-white/20 backdrop-blur-md rounded-full text-white hover:bg-white/30 transition-colors border border-white/30"
                >
                  <X size={24} />
                </button>
                <button
                  onClick={capturePhoto}
                  className="w-16 h-16 bg-white rounded-full border-4 border-zinc-300 flex items-center justify-center active:scale-95 transition-transform"
                >
                  <div className="w-12 h-12 bg-white rounded-full border-2 border-zinc-900" />
                </button>
              </div>
              <div className="absolute top-4 left-4">
                <span className="px-2 py-1 bg-red-600 text-white text-[10px] font-bold rounded flex items-center gap-1">
                  <div className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                  LIVE_FEED
                </span>
              </div>
            </div>
          ) : (
            <div className="relative rounded-2xl overflow-hidden border border-zinc-200 bg-zinc-900 shadow-xl group">
              <img src={image!} alt="Meter preview" className="w-full h-auto object-contain max-h-[500px]" />
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
                <button
                  onClick={reset}
                  className="p-3 bg-white rounded-full text-zinc-900 hover:bg-zinc-100 transition-colors shadow-lg"
                  title="Remove image"
                >
                  <RefreshCcw size={20} />
                </button>
              </div>
            </div>
          )}

          {isBatchMode && !isAnalyzing && batchResults.length === 0 && (
            <div className="bg-white border border-zinc-200 rounded-2xl p-6 shadow-sm">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-lg font-bold text-zinc-900">Batch Upload Ready</h3>
                <button 
                  onClick={() => { setIsBatchMode(false); setBatchFiles([]); }}
                  className="text-sm text-zinc-500 hover:text-zinc-700"
                >
                  Cancel
                </button>
              </div>
              
              <div className="space-y-2 mb-6 max-h-60 overflow-y-auto pr-2">
                {batchFiles.map((f, i) => (
                  <div key={i} className="flex items-center justify-between text-sm p-2 bg-zinc-50 rounded-lg border border-zinc-100">
                    <span className="truncate max-w-[200px] font-medium text-zinc-700">{f.name}</span>
                    <span className="text-zinc-400">{(f.size / 1024).toFixed(0)} KB</span>
                  </div>
                ))}
              </div>

              <button
                onClick={processBatch}
                className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold shadow-lg shadow-blue-200 transition-all flex items-center justify-center space-x-2"
              >
                <Play size={20} />
                <span>Process {batchFiles.length} Images</span>
              </button>
            </div>
          )}

          {isBatchMode && (isAnalyzing || batchResults.length > 0) && (
            <div className="bg-white border border-zinc-200 rounded-2xl p-6 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-zinc-900">
                  {isAnalyzing ? 'Processing Batch...' : 'Batch Complete'}
                </h3>
                <span className="text-sm font-mono bg-zinc-100 px-2 py-1 rounded text-zinc-600">
                  {batchProgress.current} / {batchProgress.total}
                </span>
              </div>

              <div className="w-full bg-zinc-100 h-3 rounded-full overflow-hidden mb-6">
                <motion.div 
                  initial={{ width: 0 }}
                  animate={{ width: `${(batchProgress.current / batchProgress.total) * 100}%` }}
                  className="h-full bg-blue-600"
                />
              </div>

              <div className="space-y-2 max-h-80 overflow-y-auto pr-2">
                {batchResults.map((res, i) => (
                  <div key={i} className="flex items-center justify-between p-3 rounded-xl border border-zinc-100 bg-zinc-50">
                    <div className="flex items-center space-x-3">
                      {res.status === 'success' ? (
                        <div className="p-1 bg-emerald-100 rounded-full">
                          <Check className="text-emerald-600" size={14} />
                        </div>
                      ) : (
                        <div className="p-1 bg-red-100 rounded-full">
                          <AlertCircle className="text-red-600" size={14} />
                        </div>
                      )}
                      <span className="text-sm font-medium text-zinc-700 truncate max-w-[180px]">
                        {res.name}
                      </span>
                    </div>
                    {res.status === 'error' && (
                      <span className="text-[10px] text-red-500 italic max-w-[100px] truncate">
                        {res.message}
                      </span>
                    )}
                  </div>
                ))}
                {isAnalyzing && (
                  <div className="flex items-center justify-center p-4">
                    <Loader2 className="animate-spin text-blue-600 mr-2" size={20} />
                    <span className="text-sm text-zinc-500">Processing next image...</span>
                  </div>
                )}
              </div>

              {!isAnalyzing && (
                <button
                  onClick={() => {
                    setIsBatchMode(false);
                    setBatchFiles([]);
                    setBatchResults([]);
                  }}
                  className="w-full mt-6 py-3 border border-zinc-200 hover:bg-zinc-50 text-zinc-700 rounded-xl font-bold transition-all"
                >
                  Done
                </button>
              )}
            </div>
          )}

          {image && !isBatchMode && !isAnalyzing && !result && (
            <button
              onClick={handleAnalyze}
              className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-semibold transition-all shadow-lg shadow-blue-200 flex items-center justify-center gap-2"
            >
              <Camera size={20} />
              Analyze Meter
            </button>
          )}
        </div>

        {/* Right Column: Results */}
        <div className="space-y-6">
          {isAnalyzing && !isBatchMode && (
            <div className="h-full flex flex-col items-center justify-center p-12 space-y-4 border border-zinc-100 rounded-2xl bg-white shadow-sm">
              <Loader2 className="animate-spin text-blue-600" size={48} />
              <div className="text-center">
                <p className="font-bold text-zinc-900">
                  {isLogging ? 'Syncing to Drive & Sheets' : 'Processing Image'}
                </p>
                <p className="text-sm text-zinc-500">
                  {isLogging 
                    ? 'Uploading image to Google Drive and updating spreadsheet...' 
                    : 'Extracting readings and label data using AI...'}
                </p>
              </div>
            </div>
          )}

          {error && (
            <div className="p-6 bg-red-50 border border-red-100 rounded-2xl flex gap-4">
              <AlertCircle className="text-red-500 shrink-0" size={24} />
              <div>
                <p className="font-bold text-red-900">Analysis Failed</p>
                <p className="text-sm text-red-700 mt-1">{error}</p>
                <button
                  onClick={handleAnalyze}
                  className="mt-4 text-sm font-semibold text-red-900 underline underline-offset-4"
                >
                  Try again
                </button>
              </div>
            </div>
          )}

          {result && !isBatchMode && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="p-6 bg-white border border-zinc-200 rounded-2xl shadow-sm space-y-6">
                <div className="flex items-center justify-between">
                  <h2 className="font-bold text-zinc-900 flex items-center gap-2">
                    <CheckCircle2 className="text-emerald-500" size={20} />
                    Extraction Results
                  </h2>
                  <span className="text-[10px] font-mono bg-zinc-100 px-2 py-1 rounded uppercase text-zinc-500">
                    Confidence: {(result.confidence * 100).toFixed(0)}%
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-4">
                  <div className="p-4 bg-zinc-50 rounded-xl border border-zinc-100">
                    <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest mb-1">Meter Reading</p>
                    <p className="text-4xl font-mono font-bold text-zinc-900 tracking-tighter">
                      {result.reading}
                    </p>
                  </div>

                  <div className="p-4 bg-zinc-50 rounded-xl border border-zinc-100">
                    <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest mb-1">Label / Serial</p>
                    <p className="text-xl font-semibold text-zinc-900">
                      {result.label || 'Not detected'}
                    </p>
                  </div>
                </div>

                {result.notes && (
                  <div className="pt-4 border-t border-zinc-100">
                    <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest mb-2">AI Observations</p>
                    <p className="text-sm text-zinc-600 italic">"{result.notes}"</p>
                  </div>
                )}

                <div className="pt-6 border-t border-zinc-100 space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Backend Sync Status</p>
                    {logSuccess ? (
                      <span className="text-[10px] font-bold text-emerald-600 flex items-center gap-1">
                        <FileCheck size={12} /> Logged & Saved
                      </span>
                    ) : isLogging ? (
                      <span className="text-[10px] font-bold text-blue-600 flex items-center gap-1">
                        <Loader2 size={12} className="animate-spin" /> Syncing...
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold text-zinc-400 flex items-center gap-1">
                        <Save size={12} /> Pending
                      </span>
                    )}
                  </div>
                </div>

                <button
                  onClick={reset}
                  className="w-full py-3 border border-zinc-200 hover:bg-zinc-50 text-zinc-600 rounded-xl text-sm font-semibold transition-colors"
                >
                  Scan Another Meter
                </button>
              </div>

              {/* Technical Details Card */}
              <div className="p-4 bg-zinc-900 rounded-2xl text-zinc-400 font-mono text-[10px] space-y-2">
                <p className="text-zinc-500 border-b border-zinc-800 pb-2 mb-2">SYSTEM_LOG</p>
                <p>{`> IMAGE_HASH: ${Math.random().toString(36).substring(7).toUpperCase()}`}</p>
                <p>{`> MODEL: gemini-3-flash-preview`}</p>
                <p>{`> TIMESTAMP: ${new Date().toISOString()}`}</p>
                <p className="text-emerald-500">{`> STATUS: SUCCESS`}</p>
              </div>
            </div>
          )}

          {!image && !isAnalyzing && !result && (
            <div className="space-y-6">
              <div className="flex flex-col items-center justify-center p-12 text-center space-y-4 border border-zinc-100 rounded-2xl bg-white shadow-sm">
                <div className="p-4 bg-zinc-50 rounded-full">
                  <Droplets className="text-zinc-300" size={32} />
                </div>
                <div>
                  <p className="font-bold text-zinc-900">Ready for Scan</p>
                  <p className="text-sm text-zinc-500 max-w-[200px] mx-auto">
                    Upload a clear photo of the water meter face to begin.
                  </p>
                </div>
              </div>

              {/* Backend Status Card */}
              <div className="p-6 bg-white border border-zinc-200 rounded-2xl shadow-sm space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Save className="text-blue-600" size={20} />
                    <h3 className="font-bold text-zinc-900">Backend Logging</h3>
                  </div>
                  <span className="px-2 py-1 bg-emerald-50 text-emerald-700 text-[10px] font-bold rounded-full border border-emerald-100">
                    ACTIVE
                  </span>
                </div>
                <p className="text-sm text-zinc-500">
                  All scans are automatically logged to the central database and images are stored in the server's monthly archive.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
