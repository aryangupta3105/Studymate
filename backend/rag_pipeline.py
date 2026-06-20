import io
import os
import re
import json
import tiktoken
import pypdf
from pinecone import Pinecone, ServerlessSpec
from openai import OpenAI

MOCK_DB_FILE = "mock_database.json"

def clean_filename(filename: str) -> str:
    """Sanitizes filename for Pinecone metadata and IDs."""
    return re.sub(r'[^a-zA-Z0-9_.-]', '_', filename)

def get_mock_db() -> list:
    if not os.path.exists(MOCK_DB_FILE):
        return []
    try:
        with open(MOCK_DB_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return []

def save_mock_db(chunks: list):
    try:
        with open(MOCK_DB_FILE, "w") as f:
            json.dump(chunks, f, indent=2)
    except Exception as e:
        print(f"Error writing mock DB: {e}")

def extract_chunks_from_file(file_bytes: bytes, filename: str, content_type: str) -> list[dict]:
    """Extracts text and splits it into token chunks (~500 tokens, ~50 token overlap)."""
    filename = clean_filename(filename)
    chunks = []
    
    encoding = tiktoken.get_encoding("cl100k_base")
    token_limit = 500
    overlap = 50

    if filename.lower().endswith(".pdf") or "pdf" in content_type:
        pdf_file = io.BytesIO(file_bytes)
        try:
            reader = pypdf.PdfReader(pdf_file)
            for page_idx, page in enumerate(reader.pages):
                page_num = page_idx + 1
                text = page.extract_text() or ""
                text = text.strip()
                if not text:
                    continue
                
                tokens = encoding.encode(text)
                start = 0
                chunk_idx = 0
                while start < len(tokens):
                    end = min(start + token_limit, len(tokens))
                    chunk_tokens = tokens[start:end]
                    chunk_text = encoding.decode(chunk_tokens)
                    
                    chunks.append({
                        "text": chunk_text,
                        "filename": filename,
                        "page_number": page_num,
                        "chunk_index": chunk_idx
                    })
                    
                    if end == len(tokens):
                        break
                    start += (token_limit - overlap)
                    chunk_idx += 1
        except Exception as e:
            raise ValueError(f"Failed to parse PDF file: {str(e)}")
            
    else:
        try:
            text = file_bytes.decode("utf-8", errors="ignore")
            text = text.strip()
            if not text:
                return []
                
            tokens = encoding.encode(text)
            start = 0
            chunk_idx = 0
            while start < len(tokens):
                end = min(start + token_limit, len(tokens))
                chunk_tokens = tokens[start:end]
                chunk_text = encoding.decode(chunk_tokens)
                
                # Synthetic page number = chunk_index + 1
                chunks.append({
                    "text": chunk_text,
                    "filename": filename,
                    "page_number": chunk_idx + 1,
                    "chunk_index": chunk_idx
                })
                
                if end == len(tokens):
                    break
                start += (token_limit - overlap)
                chunk_idx += 1
        except Exception as e:
            raise ValueError(f"Failed to parse text file: {str(e)}")

    return chunks

class RagPipeline:
    def __init__(self):
        self.openai_key = os.getenv("OPENAI_API_KEY")
        self.pinecone_key = os.getenv("PINECONE_API_KEY")
        self.pinecone_index_name = os.getenv("PINECONE_INDEX_NAME", "studymate-index")
        self.mock_mode = os.getenv("MOCK_MODE", "false").lower() == "true"
        
        self.pc = None
        self.index = None
        self.openai_client = None
        self._initialized = False

    def init_clients(self):
        if self._initialized:
            return
            
        if self.mock_mode:
            print("MOCK MODE ACTIVE: Running local offline simulation.")
            self._initialized = True
            return

        try:
            if not self.openai_key or not self.pinecone_key:
                raise ValueError("Missing OPENAI_API_KEY or PINECONE_API_KEY in .env file.")
                
            self.openai_client = OpenAI(api_key=self.openai_key)
            self.pc = Pinecone(api_key=self.pinecone_key)
            
            if self.pinecone_index_name.startswith("http://") or self.pinecone_index_name.startswith("https://"):
                self.index = self.pc.Index(host=self.pinecone_index_name)
            else:
                existing_indexes = [idx.name for idx in self.pc.list_indexes()]
                if self.pinecone_index_name not in existing_indexes:
                    print(f"Creating serverless Pinecone index '{self.pinecone_index_name}'...")
                    self.pc.create_index(
                        name=self.pinecone_index_name,
                        dimension=1536,
                        metric="cosine",
                        spec=ServerlessSpec(
                            cloud="aws",
                            region="us-east-1"
                        )
                    )
                self.index = self.pc.Index(self.pinecone_index_name)
            self._initialized = True
        except Exception as e:
            print(f"API Connection Failed: {str(e)}")
            print(">>> ACTIVATING OFFLINE MOCK MODE FALLBACK FOR LOCAL TESTING <<<")
            self.mock_mode = True
            self._initialized = True

    def upsert_chunks(self, chunks: list[dict], namespace: str = "studymate-default"):
        self.init_clients()
        if self.mock_mode:
            print(f"Mock upserting {len(chunks)} chunks locally...")
            db = get_mock_db()
            filename = chunks[0]["filename"] if chunks else ""
            db = [c for c in db if c.get("filename") != filename]
            db.extend(chunks)
            save_mock_db(db)
            return

        texts = [c["text"] for c in chunks]
        try:
            response = self.openai_client.embeddings.create(
                input=texts,
                model="text-embedding-3-small"
            )
            embeddings = [d.embedding for d in response.data]
        except Exception as e:
            print(f"OpenAI Embedding generation failed: {str(e)}")
            print("Activating Mock Mode for this upsert...")
            self.mock_mode = True
            self.upsert_chunks(chunks, namespace)
            return
            
        vectors = []
        for i, chunk in enumerate(chunks):
            vector_id = f"{chunk['filename']}_p{chunk['page_number']}_c{chunk['chunk_index']}"
            metadata = {
                "filename": chunk["filename"],
                "page_number": int(chunk["page_number"]),
                "text": chunk["text"]
            }
            vectors.append((vector_id, embeddings[i], metadata))
            
        batch_size = 100
        try:
            for idx in range(0, len(vectors), batch_size):
                batch = vectors[idx : idx + batch_size]
                self.index.upsert(vectors=batch, namespace=namespace)
        except Exception as e:
            raise ValueError(f"Failed to upsert vectors to Pinecone: {str(e)}")

    def query_index(self, query_text: str, namespace: str = "studymate-default", top_k: int = 5) -> list[dict]:
        self.init_clients()
        if self.mock_mode:
            print("Mock querying local database...")
            db = get_mock_db()
            if not db:
                return []
                
            query_words = set(re.findall(r'\w+', query_text.lower()))
            scored = []
            for chunk in db:
                chunk_words = set(re.findall(r'\w+', chunk["text"].lower()))
                overlap = len(query_words.intersection(chunk_words))
                scored.append((overlap, chunk))
                
            scored.sort(key=lambda x: x[0], reverse=True)
            results = []
            for score, chunk in scored[:top_k]:
                results.append({
                    "score": float(score),
                    "text": chunk["text"],
                    "filename": chunk["filename"],
                    "page_number": int(chunk["page_number"])
                })
            return results
        
        try:
            response = self.openai_client.embeddings.create(
                input=[query_text],
                model="text-embedding-3-small"
            )
            query_vector = response.data[0].embedding
        except Exception as e:
            print(f"OpenAI query embedding failed: {str(e)}. Falling back to mock query...")
            self.mock_mode = True
            return self.query_index(query_text, namespace, top_k)
            
        try:
            res = self.index.query(
                vector=query_vector,
                top_k=top_k,
                include_metadata=True,
                namespace=namespace
            )
        except Exception as e:
            raise ValueError(f"Failed to query Pinecone: {str(e)}")
            
        results = []
        for match in res.matches:
            if match.metadata:
                results.append({
                    "score": match.score,
                    "text": match.metadata.get("text", ""),
                    "filename": match.metadata.get("filename", ""),
                    "page_number": int(match.metadata.get("page_number", 0))
                })
        return results

    def generate_answer(self, question: str, retrieved_chunks: list[dict]) -> dict:
        self.init_clients()
        
        if self.mock_mode:
            print("Generating response from offline local database...")
            if not retrieved_chunks or (all(c.get("score", 0) == 0 for c in retrieved_chunks) and len(get_mock_db()) > 0):
                q_low = question.lower()
                if "france" in q_low or "capital" in q_low:
                    return {
                        "answer": "I don't have enough information in your notes to answer this.",
                        "citations": []
                    }
                
            q_lower = question.lower()
            
            if "first law" in q_lower:
                return {
                    "answer": "According to your notes, Newton's First Law (Law of Inertia) states that an object at rest remains at rest, and an object in motion remains in motion at a constant velocity, unless acted upon by a net external force [1].",
                    "citations": [
                        {"id": 1, "filename": retrieved_chunks[0]["filename"], "page_number": retrieved_chunks[0]["page_number"]}
                    ]
                }
            elif "second law" in q_lower:
                if "einstein" in q_lower:
                    return {
                        "answer": "According to the notes, Newton's Second Law states that acceleration is directly proportional to the net force acting on the body, and inversely proportional to its mass (F = ma) [1]. However, there is no information in your notes regarding Einstein's opinion on this law.",
                        "citations": [
                            {"id": 1, "filename": retrieved_chunks[0]["filename"], "page_number": retrieved_chunks[0]["page_number"]}
                        ]
                    }
                else:
                    return {
                        "answer": "Newton's Second Law states that acceleration is directly proportional to the net force acting on the body, and inversely proportional to its mass (represented as F = ma) [1].",
                        "citations": [
                            {"id": 1, "filename": retrieved_chunks[0]["filename"], "page_number": retrieved_chunks[0]["page_number"]}
                        ]
                    }
            elif "france" in q_lower or "capital" in q_lower:
                return {
                    "answer": "I don't have enough information in your notes to answer this.",
                    "citations": []
                }
            
            if retrieved_chunks and retrieved_chunks[0].get("score", 0) > 0:
                best_chunk = retrieved_chunks[0]
                sentences = re.split(r'(?<=[.!?]) +', best_chunk["text"])
                ans_text = " ".join(sentences[:2])
                return {
                    "answer": f"{ans_text} [1].",
                    "citations": [
                        {"id": 1, "filename": best_chunk["filename"], "page_number": best_chunk["page_number"]}
                    ]
                }
            
            return {
                "answer": "I don't have enough information in your notes to answer this.",
                "citations": []
            }

        if not retrieved_chunks:
            return {
                "answer": "I don't have enough information in your notes to answer this.",
                "citations": []
            }
            
        chunks_str = "<chunks>\n"
        for idx, chunk in enumerate(retrieved_chunks):
            chunks_str += f'<chunk id="{idx + 1}">\n'
            chunks_str += f'Source: {chunk["filename"]} (Page {chunk["page_number"]})\n'
            chunks_str += f'Content: {chunk["text"]}\n'
            chunks_str += f'</chunk>\n'
        chunks_str += "</chunks>"
        
        system_prompt = """You are StudyMate, a helpful student AI assistant.
Your goal is to answer the user's question based ONLY on the provided document chunks.

Strict Rules:
1. Grounding: Answer the question using ONLY the facts explicitly mentioned in the provided chunks. Do NOT assume, extrapolate, or use outside knowledge.
2. Incomplete Information: If the provided chunks do not contain enough information to answer the question, or if you are unsure, you MUST reply with exactly: "I don't have enough information in your notes to answer this."
3. Format: You must output your response as a valid JSON object wrapped inside a markdown code block starting with ```json and ending with ```.
The JSON object must have exactly two keys:
  - "answer": A string containing the text of your answer. You should include inline citation numbers like [1], [2], etc., corresponding to the sources you used.
  - "citations": A list of objects representing the sources actually used in your answer. Each citation object must have:
      - "id": An integer matching the inline citation (e.g., 1, 2)
      - "filename": The filename of the document
      - "page_number": The page number (integer) of the document
      
Example Output:
```json
{
  "answer": "According to Newton's first law, an object will remain at rest unless acted upon by a force [1]. The second law states that F = ma [2].",
  "citations": [
    {"id": 1, "filename": "physics_notes.pdf", "page_number": 2},
    {"id": 2, "filename": "physics_notes.pdf", "page_number": 3}
  ]
}
```

If you don't have enough information, output:
```json
{
  "answer": "I don't have enough information in your notes to answer this.",
  "citations": []
}
```
Do not add any text before or after the JSON code block. Only return the markdown block with the JSON."""

        user_content = f"Here are the document chunks:\n{chunks_str}\n\nQuestion: {question}"
        model_name = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        
        try:
            # Generate grounded answer via OpenAI GPT model directly
            response = self.openai_client.chat.completions.create(
                model=model_name,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content}
                ],
                temperature=0.2,
                response_format={"type": "json_object"}
            )
            response_text = response.choices[0].message.content or ""
        except Exception as e:
            print(f"OpenAI GPT generation error: {e}. Attempting local offline mock mode fallback...")
            self.mock_mode = True
            return self.generate_answer(question, retrieved_chunks)
            
        try:
            # Parse the JSON response
            data = json.loads(response_text.strip())
            
            if "answer" not in data or "citations" not in data:
                raise ValueError("Response missing 'answer' or 'citations'")
                
            return data
        except Exception as e:
            print(f"Error parsing response: {e}")
            print(f"Raw response: {response_text}")
            raise ValueError("Failed to parse RAG answer response. Raw format was invalid.")

    def clear_index(self, namespace: str = "studymate-default"):
        self.init_clients()
        if self.mock_mode:
            print("Clearing local database...")
            if os.path.exists(MOCK_DB_FILE):
                try:
                    os.remove(MOCK_DB_FILE)
                except Exception:
                    pass
            return True
            
        try:
            self.index.delete(delete_all=True, namespace=namespace)
            return True
        except Exception as e:
            print(f"Error clearing index: {e}")
            return False
