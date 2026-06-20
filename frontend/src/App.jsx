import React, { useState, useEffect, useRef } from 'react';

const API_BASE = 'http://localhost:8000/api';

function App() {
  const [files, setFiles] = useState([]);
  const [totalChunks, setTotalChunks] = useState(0);
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [chatError, setChatError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  
  // Citation Drawer State
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [activeCitation, setActiveCitation] = useState(null);

  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);

  // Fetch status on mount
  useEffect(() => {
    fetchStatus();
  }, []);

  // Auto-scroll chat to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const fetchStatus = async () => {
    try {
      const res = await fetch(`${API_BASE}/status`);
      if (!res.ok) throw new Error('Failed to fetch backend status');
      const data = await res.json();
      setFiles(data.files || []);
      setTotalChunks(data.total_chunks || 0);
    } catch (err) {
      console.error(err);
    }
  };

  const handleUpload = async (file) => {
    if (!file) return;

    // Size limit check (20MB)
    const maxSize = 20 * 1024 * 1024;
    if (file.size > maxSize) {
      setUploadError('File exceeds 20MB limit.');
      return;
    }

    // Type check (.pdf, .txt)
    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    if (ext !== '.pdf' && ext !== '.txt') {
      setUploadError('Unsupported format. Only .pdf and .txt allowed.');
      return;
    }

    setIsUploading(true);
    setUploadError('');

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch(`${API_BASE}/upload`, {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'Upload failed');
      }

      await fetchStatus();
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    handleUpload(file);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    handleUpload(file);
  };

  const handleClearAll = async () => {
    if (!window.confirm('Are you sure you want to clear all documents? This will clear the index.')) return;
    try {
      const res = await fetch(`${API_BASE}/clear`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to clear documents');
      await fetchStatus();
      setMessages([]);
    } catch (err) {
      setUploadError(err.message);
    }
  };

  const handleSendQuery = async (e) => {
    if (e) e.preventDefault();
    const query = inputValue.trim();
    if (!query) return;

    const userMsg = {
      sender: 'user',
      text: query,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    
    setMessages(prev => [...prev, userMsg]);
    setInputValue('');
    setIsLoading(true);
    setChatError('');

    try {
      const res = await fetch(`${API_BASE}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: query }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'Failed to generate answer.');
      }

      const assistantMsg = {
        sender: 'assistant',
        text: data.answer,
        citations: data.citations || [],
        retrieved_chunks: data.retrieved_chunks || [],
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      
      setMessages(prev => [...prev, assistantMsg]);
    } catch (err) {
      setChatError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCitationClick = (citation, retrievedChunks) => {
    const matchingChunk = (retrievedChunks || []).find(
      chunk => chunk.filename === citation.filename && chunk.page_number === citation.page_number
    );

    setActiveCitation({
      ...citation,
      snippet: matchingChunk ? matchingChunk.text : 'Source snippet not available in the local retrieval context.'
    });
    setIsDrawerOpen(true);
  };

  const renderMessageText = (msg) => {
    const { text, citations, retrieved_chunks } = msg;
    if (!citations || citations.length === 0) {
      return <span>{text}</span>;
    }

    const parts = text.split(/(\[\d+\])/g);
    return parts.map((part, index) => {
      const match = part.match(/^\[(\d+)\]$/);
      if (match) {
        const citationId = parseInt(match[1], 10);
        const citation = citations.find(c => c.id === citationId);
        if (citation) {
          return (
            <button
              key={index}
              onClick={() => handleCitationClick(citation, retrieved_chunks)}
              className="inline-flex items-center gap-1 border-[2px] border-on-surface px-1.5 py-0.5 font-label-md text-xs bg-secondary-container text-on-surface shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-[1px] active:translate-y-[1px] active:shadow-none transition-all mx-0.5 align-baseline font-bold"
              title={`Source: ${citation.filename}, p. ${citation.page_number}`}
            >
              [{citationId}]
            </button>
          );
        }
      }
      return <span key={index}>{part}</span>;
    });
  };

  const formatSize = (bytes) => {
    if (!bytes) return '0 KB';
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    return `${(kb / 1024).toFixed(1)} MB`;
  };

  return (
    <div className="w-full h-full flex overflow-hidden">
      {/* SIDE NAV BAR (Desktop) */}
      <nav className="hidden md:flex flex-col h-screen p-4 gap-4 bg-surface w-64 border-r-[3px] border-on-surface shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] z-10 shrink-0 overflow-y-auto">
        <div className="flex items-center gap-2 mb-4 mt-2">
          <span className="material-symbols-outlined text-4xl text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>school</span>
          <div className="flex flex-col">
            <span className="font-display text-2xl font-extrabold text-primary uppercase tracking-tighter leading-none">StudyMate</span>
            <span className="font-label-md text-[10px] text-on-surface-variant uppercase tracking-widest mt-1">Power Through</span>
          </div>
        </div>

        {/* Drag & Drop Upload Zone */}
        <div 
          className={`border-[3px] border-on-surface shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] p-4 flex flex-col items-center justify-center text-center relative hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] hover:translate-x-[-1px] hover:translate-y-[-1px] transition-all cursor-pointer min-h-[140px] select-none ${dragOver ? 'bg-secondary-container bg-opacity-20' : 'bg-primary-container'}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileChange} 
            accept=".pdf,.txt" 
            style={{ display: 'none' }} 
          />
          <span className="material-symbols-outlined text-3xl mb-1">upload_file</span>
          <span className="font-label-md text-xs font-bold uppercase">Drag File Here</span>
          <span className="font-label-md text-[10px] uppercase opacity-75 mt-0.5">or browse</span>
          <span className="font-label-md text-[9px] uppercase font-bold mt-1">PDF / TXT (Max 20MB)</span>

          {isUploading && (
            <div className="absolute inset-0 bg-surface border-none flex flex-col items-center justify-center p-2 z-20">
              <span className="material-symbols-outlined text-3xl animate-spin mb-1 text-secondary-container">sync</span>
              <span className="font-label-md text-xs font-extrabold">INDEXING...</span>
            </div>
          )}
        </div>

        {/* Upload Error Display */}
        {uploadError && (
          <div className="border-[3px] border-on-surface bg-red-100 p-3 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] flex flex-col gap-1">
            <div className="flex gap-2 items-center text-red-700">
              <span className="material-symbols-outlined text-lg">warning</span>
              <span className="font-label-md text-xs font-extrabold uppercase">UPLOAD ERROR</span>
            </div>
            <p className="text-xs font-semibold text-red-950 leading-tight">{uploadError}</p>
          </div>
        )}

        {/* Vault Capacity indicator */}
        <div className="border-[3px] border-on-surface shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] bg-surface p-3 mt-1">
          <span className="font-label-md text-xs uppercase mb-2 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-base">storage</span> Vault Capacity
          </span>
          <div className="flex justify-between font-label-md text-[10px] mb-1 font-bold">
            <span>{files.length} Notes</span>
            <span>{totalChunks} Chunks</span>
          </div>
          <div className="h-4 w-full border-[2.5px] border-on-surface bg-surface relative overflow-hidden">
            <div 
              className="absolute top-0 left-0 h-full bg-secondary-container border-r-[2.5px] border-on-surface transition-all duration-300"
              style={{ width: `${Math.min(100, (totalChunks / 200) * 100)}%` }}
            />
          </div>
        </div>

        {/* Document Tracker List */}
        <div className="flex flex-col gap-2 flex-grow overflow-y-auto mt-2">
          <span className="font-label-md text-xs uppercase flex items-center gap-1 text-on-surface-variant mb-1 font-bold">
            <span className="material-symbols-outlined text-base">description</span> INDEXED FILES
          </span>
          
          <div className="flex flex-col gap-3">
            {files.length === 0 ? (
              <div className="border-[3px] border-dashed border-gray-400 p-4 text-center text-gray-500 font-label-md text-xs bg-surface-container-low font-medium">
                Vault is empty.
              </div>
            ) : (
              files.map((file, i) => (
                <div key={i} className="bg-surface border-[3px] border-on-surface shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] p-2.5 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2 overflow-hidden">
                    <span className="material-symbols-outlined text-lg flex-shrink-0">article</span>
                    <span 
                      className="font-label-md text-xs font-bold text-ellipsis overflow-hidden whiteSpace-nowrap"
                      title={file.filename}
                    >
                      {file.filename}
                    </span>
                  </div>
                  <div className="flex justify-between text-[9px] font-bold font-mono">
                    <span>{formatSize(file.file_size)}</span>
                    <span className="bg-primary-container border-[1.5px] border-on-surface px-1">
                      {file.chunk_count} CHUNKS
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Clear index button */}
        {files.length > 0 && (
          <button 
            className="w-full bg-secondary-container text-on-surface border-[3px] border-on-surface shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] py-2 px-3 font-label-md text-xs font-bold uppercase hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] active:translate-x-[4px] active:translate-y-[4px] active:shadow-none transition-all flex items-center justify-center gap-1" 
            onClick={handleClearAll}
          >
            <span className="material-symbols-outlined text-sm">delete</span> CLEAR VAULT
          </button>
        )}
      </nav>

      {/* MAIN CANVAS */}
      <main className="flex-grow flex flex-col h-screen relative bg-surface-container-lowest">
        
        {/* TopNavBar (Mobile only) */}
        <header className="md:hidden flex justify-between items-center px-4 py-3 w-full bg-surface border-b-[3px] border-on-surface z-20 shrink-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-3xl text-primary">school</span>
            <span className="font-display text-xl font-extrabold text-primary uppercase tracking-tighter">StudyMate</span>
          </div>
          <span className="font-label-md text-[10px] bg-primary-container border-[2px] border-on-surface px-2 py-0.5 font-bold">
            FILES: {files.length}
          </span>
        </header>

        {/* Workspace Title & Stats header */}
        <div className="px-margin-desktop py-5 border-b-[3px] border-on-surface bg-surface flex items-center justify-between shrink-0">
          <div>
            <h1 className="font-headline-lg text-2xl md:text-3xl uppercase text-on-surface tracking-tight leading-none">Grounded Study Assistant</h1>
            <p className="font-body-md text-xs text-on-surface-variant mt-1.5">
              Strictly fact-grounded in your documents. Outside knowledge is locked.
            </p>
          </div>
          <div className="hidden md:flex gap-3">
            <span className="font-label-md text-xs bg-primary-container border-[3px] border-on-surface px-3 py-1.5 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] font-bold text-on-surface uppercase">
              CHUNKS: {totalChunks}
            </span>
            <span className="font-label-md text-xs bg-surface border-[3px] border-on-surface px-3 py-1.5 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] font-bold text-on-surface uppercase">
              RAG: SECURE
            </span>
          </div>
        </div>

        {/* Chat Message Thread */}
        <div className="flex-grow overflow-y-auto p-4 md:p-8 flex flex-col gap-6 pb-28">
          
          {/* Greeting message if thread is empty */}
          {messages.length === 0 ? (
            <div className="margin-auto max-w-xl mx-auto my-auto border-[3px] border-on-surface shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] bg-surface p-6 flex flex-col gap-4 text-left">
              <div className="flex items-center gap-2.5">
                <span className="material-symbols-outlined text-3xl text-primary">forum</span>
                <h3 className="font-headline-lg text-lg uppercase">Grounded RAG Sandbox</h3>
              </div>
              <p className="font-body-md text-sm leading-relaxed text-on-surface">
                To test StudyMate's strict RAG grounding, drag files into the sidebar and run queries. The assistant will answer using **only** the provided paragraphs, including citations back to pages and filenames.
              </p>
              
              <div className="flex flex-col gap-2 pt-2 border-t-[3px] border-on-surface">
                <span className="font-label-md text-[11px] font-bold text-on-surface-variant uppercase">
                  Strict Hallucination Control:
                </span>
                <div className="border-[2px] border-on-surface p-2.5 text-xs bg-surface-container leading-relaxed">
                  <strong>Question not answerable from notes?</strong> Claude is instructed to answer with: <em>"I don't have enough information in your notes to answer this."</em>
                </div>
              </div>
            </div>
          ) : (
            messages.map((msg, idx) => (
              <div 
                key={idx} 
                className={`flex w-full ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {msg.sender === 'user' ? (
                  /* USER MESSAGE */
                  <div className="max-w-[80%] md:max-w-[65%] flex flex-col items-end">
                    <div className="bg-tertiary-fixed border-[3px] border-on-surface p-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] text-on-surface font-body-lg text-sm md:text-base font-medium">
                      {msg.text}
                    </div>
                    <span className="font-label-md text-[10px] text-on-surface-variant uppercase mt-1">
                      YOU • {msg.timestamp}
                    </span>
                  </div>
                ) : (
                  /* AI MESSAGE */
                  <div className="max-w-[90%] md:max-w-[75%] flex flex-col items-start gap-2.5 w-full">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 bg-primary-container border-[2px] border-on-surface flex items-center justify-center shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)]">
                        <span className="material-symbols-outlined text-sm font-bold text-on-surface">smart_toy</span>
                      </div>
                      <span className="font-label-md text-xs uppercase tracking-wider text-on-surface font-bold">
                        StudyMate AI
                      </span>
                    </div>

                    <div className="bg-surface border-[3px] border-on-surface p-5 shadow-[5px_5px_0px_0px_rgba(0,0,0,1)] text-on-surface font-body-md text-sm md:text-base w-full leading-relaxed">
                      <div>
                        {renderMessageText(msg)}
                      </div>

                      {/* Sources block in bubble */}
                      {msg.citations && msg.citations.length > 0 && (
                        <div className="mt-5 pt-3.5 border-t-[3px] border-on-surface">
                          <span className="font-label-md text-[10px] uppercase text-on-surface-variant block mb-2 font-extrabold">
                            Sources Referenced:
                          </span>
                          <div className="flex flex-wrap gap-2">
                            {msg.citations.map((citation, cIdx) => (
                              <span 
                                key={cIdx} 
                                onClick={() => handleCitationClick(citation, msg.retrieved_chunks)}
                                className="citation-chip select-none"
                              >
                                <span className="material-symbols-outlined text-xs">menu_book</span>
                                {citation.filename} (p. {citation.page_number})
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    
                    <span className="font-label-md text-[10px] text-on-surface-variant uppercase">
                      STUDYMATE • {msg.timestamp}
                    </span>
                  </div>
                )}
              </div>
            ))
          )}

          {/* Loader bubble */}
          {isLoading && (
            <div className="flex justify-start w-full">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-surface-variant border-[3px] border-on-surface flex items-center justify-center animate-pulse">
                  <span className="material-symbols-outlined text-base animate-spin">sync</span>
                </div>
                <span className="font-label-md text-xs uppercase font-extrabold text-on-surface-variant">
                  Retrieving context & reasoning...
                </span>
              </div>
            </div>
          )}

          {/* Chat query hard error card */}
          {chatError && (
            <div className="border-[3px] border-on-surface shadow-[5px_5px_0px_0px_rgba(0,0,0,1)] bg-red-100 p-4 max-w-[80%] align-self-start flex flex-col gap-2">
              <div className="flex gap-2 items-center text-red-700">
                <span className="material-symbols-outlined">error_outline</span>
                <span className="font-label-md text-sm font-extrabold uppercase">RAG GENERATION FAILURE</span>
              </div>
              <p className="text-sm font-semibold text-red-950 leading-snug">{chatError}</p>
              <p className="text-[11px] font-bold text-red-900 opacity-80 leading-normal">
                Strict Claude schema validation failed. The API rejected the formatting or failed to initialize context. Check backend credentials.
              </p>
            </div>
          )}
          
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area (Fixed Bottom) */}
        <div className="absolute bottom-0 w-full p-4 md:p-6 bg-surface border-t-[3px] border-on-surface z-10 shrink-0">
          <form onSubmit={handleSendQuery} className="max-w-4xl mx-auto flex gap-4 relative">
            <div className="relative flex-grow">
              <textarea
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendQuery();
                  }
                }}
                placeholder={files.length === 0 ? "Upload notes in sidebar first..." : "Ask something about your study notes..."}
                disabled={files.length === 0 || isLoading}
                className="w-full bg-surface-container-lowest border-[3px] border-on-surface p-4 font-body-md text-sm md:text-base text-on-surface focus:outline-none focus:ring-0 focus:shadow-[4px_4px_0px_0px_#00daf8] transition-shadow resize-none h-[60px] min-h-[60px]"
              />
            </div>
            <button
              type="submit"
              disabled={files.length === 0 || isLoading || !inputValue.trim()}
              className="bg-primary-container border-[3px] border-on-surface px-6 py-2 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] font-label-md text-sm uppercase text-on-surface hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] active:translate-x-[4px] active:translate-y-[4px] active:shadow-none transition-all flex items-center justify-center h-[60px] shrink-0"
            >
              <span className="material-symbols-outlined text-lg mr-1.5">send</span> ASK
            </button>
          </form>
        </div>
      </main>

      {/* DRAWER COMPONENT: Displays exact source chunk text snippet */}
      <div 
        className={`fixed inset-0 bg-black bg-opacity-40 z-40 transition-opacity duration-200 ${isDrawerOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`} 
        onClick={() => setIsDrawerOpen(false)} 
      />
      <div className={`fixed right-0 top-0 bottom-0 w-[420px] max-w-full bg-surface border-l-[4px] border-on-surface shadow-[-10px_0px_0px_rgba(0,0,0,0.15)] p-6 flex flex-col gap-4 z-50 transition-transform duration-300 ease-out ${isDrawerOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        {activeCitation && (
          <>
            <div className="flex justify-between items-center border-b-[3px] border-on-surface pb-3 shrink-0">
              <h3 className="font-headline-lg text-lg uppercase flex items-center gap-1.5">
                <span className="material-symbols-outlined">book_open</span> Source Citation
              </h3>
              <button 
                className="text-on-surface hover:text-secondary-container transition-colors" 
                onClick={() => setIsDrawerOpen(false)}
              >
                <span className="material-symbols-outlined text-3xl font-extrabold">close</span>
              </button>
            </div>
            
            <div className="flex-grow overflow-y-auto flex flex-col gap-4">
              <div className="bg-tertiary-fixed border-[3px] border-on-surface shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] p-3">
                <span className="font-label-md text-[10px] font-bold text-on-surface-variant block uppercase">File Name</span>
                <span className="font-label-md text-xs font-extrabold word-break-all leading-tight mt-0.5 block">
                  {activeCitation.filename}
                </span>
              </div>
              
              <div className="bg-primary-container border-[3px] border-on-surface shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] p-3">
                <span className="font-label-md text-[10px] font-bold text-on-surface-variant block uppercase">Source Location</span>
                <span className="font-label-md text-base font-extrabold mt-0.5 block">
                  Page {activeCitation.page_number}
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="font-label-md text-[10px] font-bold text-on-surface-variant uppercase">
                  Retrieved Paragraph Snippet:
                </span>
                <div 
                  className="border-[3px] border-on-surface p-4 bg-surface-container-lowest text-xs leading-relaxed max-h-[340px] overflow-y-auto whitespace-pre-wrap select-text font-medium"
                >
                  {activeCitation.snippet}
                </div>
              </div>
            </div>

            <div className="flex gap-2 text-[10px] text-on-surface-variant items-center border-t-[3px] border-on-surface pt-3 shrink-0">
              <span className="material-symbols-outlined text-base text-primary">check_circle</span>
              <span className="font-semibold">Verified grounding source from index metadata.</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
