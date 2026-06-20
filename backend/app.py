import os
import json
from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

# Load env variables
load_dotenv()

from rag_pipeline import RagPipeline, extract_chunks_from_file

app = FastAPI(title="StudyMate API", description="StudyMate RAG backend")

# CORS middleware to allow connection from React Dev Server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# RAG pipeline instance
rag = RagPipeline()

# Simple JSON-based file tracker to maintain session index status
UPLOAD_TRACKER = "uploaded_files.json"
DEFAULT_NAMESPACE = "studymate-default"

def get_uploaded_files(namespace: str) -> dict:
    if not os.path.exists(UPLOAD_TRACKER):
        return {}
    try:
        with open(UPLOAD_TRACKER, "r") as f:
            data = json.load(f)
            return data.get(namespace, {})
    except Exception:
        return {}

def save_uploaded_files(namespace: str, files_dict: dict):
    data = {}
    if os.path.exists(UPLOAD_TRACKER):
        try:
            with open(UPLOAD_TRACKER, "r") as f:
                data = json.load(f)
        except Exception:
            pass
    data[namespace] = files_dict
    try:
        with open(UPLOAD_TRACKER, "w") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print(f"Error saving upload tracker: {e}")

def get_unique_filename(filename: str, existing_filenames: list) -> str:
    if filename not in existing_filenames:
        return filename
    name, ext = os.path.splitext(filename)
    counter = 2
    while True:
        new_filename = f"{name} ({counter}){ext}"
        if new_filename not in existing_filenames:
            return new_filename
        counter += 1

class QueryRequest(BaseModel):
    question: str

@app.get("/api/status")
def get_status():
    """Returns the list of uploaded files, their chunk counts, and total chunks."""
    files_dict = get_uploaded_files(DEFAULT_NAMESPACE)
    files_list = []
    total_chunks = 0
    for fname, info in files_dict.items():
        files_list.append({
            "filename": fname,
            "chunk_count": info.get("chunk_count", 0),
            "file_size": info.get("file_size", 0)
        })
        total_chunks += info.get("chunk_count", 0)
    return {
        "files": files_list,
        "total_chunks": total_chunks
    }

@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    """Validates, processes, chunks, embeds, and indexes a PDF/text file."""
    # 1. Enforce file type allowlist
    filename = file.filename or "unknown"
    ext = os.path.splitext(filename)[1].lower()
    if ext not in [".pdf", ".txt"]:
        raise HTTPException(
            status_code=400,
            detail="Unsupported file format. Only .pdf and .txt files are allowed."
        )

    # 2. Enforce file size limit (20MB = 20 * 1024 * 1024 bytes)
    max_size = 20 * 1024 * 1024
    content = await file.read()
    file_size = len(content)
    if file_size > max_size:
        raise HTTPException(
            status_code=400,
            detail="File is too large. Maximum allowed size is 20MB."
        )

    # 3. Handle duplicates
    files_dict = get_uploaded_files(DEFAULT_NAMESPACE)
    unique_name = get_unique_filename(filename, list(files_dict.keys()))

    # 4. Extract and Chunk
    try:
        chunks = extract_chunks_from_file(content, unique_name, file.content_type or "")
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Text extraction failed: {str(e)}")

    if not chunks:
        raise HTTPException(
            status_code=400,
            detail="The uploaded file contains no extractable text."
        )

    # 5. Embed and Upsert
    try:
        rag.upsert_chunks(chunks, namespace=DEFAULT_NAMESPACE)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to store vector embeddings: {str(e)}"
        )

    # 6. Save tracking state
    files_dict[unique_name] = {
        "chunk_count": len(chunks),
        "file_size": file_size
    }
    save_uploaded_files(DEFAULT_NAMESPACE, files_dict)

    return {
        "status": "success",
        "filename": unique_name,
        "chunk_count": len(chunks),
        "file_size": file_size
    }

@app.post("/api/query")
def query_notes(request: QueryRequest):
    """Retrieves context and gets a structured answer from Claude."""
    question = request.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    # 1. Retrieve top-5 chunks
    try:
        retrieved = rag.query_index(question, namespace=DEFAULT_NAMESPACE, top_k=5)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Vector search query failed: {str(e)}")

    # 2. Get answer from Claude
    try:
        answer_data = rag.generate_answer(question, retrieved)
        return answer_data
    except Exception as e:
        # Returns a hard error as per gap resolution
        raise HTTPException(
            status_code=500,
            detail=f"Claude Generation Error: {str(e)}"
        )

@app.post("/api/clear")
def clear_notes():
    """Clears all vectors in the Pinecone namespace and resets local tracker."""
    success = rag.clear_index(namespace=DEFAULT_NAMESPACE)
    if not success:
         raise HTTPException(status_code=500, detail="Failed to clear Pinecone index vectors.")
    
    # Reset local tracking
    save_uploaded_files(DEFAULT_NAMESPACE, {})
    return {"status": "success", "message": "All indexed documents cleared successfully."}

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    host = os.getenv("HOST", "127.0.0.1")
    uvicorn.run("app:app", host=host, port=port, reload=True)
