import os
import sys
from dotenv import load_dotenv

# Load env variables
load_dotenv()

from rag_pipeline import extract_chunks_from_file, RagPipeline

def test_text_chunking():
    print("--- Running Text Chunker Unit Tests ---")
    
    # 1. Test short text file chunking (under 500 tokens)
    text_content = "This is a short note on physics. Force equals mass times acceleration."
    file_bytes = text_content.encode("utf-8")
    filename = "test_notes.txt"
    content_type = "text/plain"
    
    chunks = extract_chunks_from_file(file_bytes, filename, content_type)
    print(f"Short text file chunk count: {len(chunks)}")
    assert len(chunks) == 1, "Expected exactly 1 chunk"
    assert chunks[0]["filename"] == "test_notes.txt", "Filename mismatch"
    assert chunks[0]["page_number"] == 1, "Expected synthetic page number = 1"
    assert "Force equals mass" in chunks[0]["text"]
    
    # 2. Test long text file chunking (forcing multi-chunk split with overlap)
    # Generate text with ~600 tokens
    long_text = " ".join([f"Word{i}" for i in range(700)])
    long_bytes = long_text.encode("utf-8")
    
    long_chunks = extract_chunks_from_file(long_bytes, filename, content_type)
    print(f"Long text file chunk count: {len(long_chunks)}")
    assert len(long_chunks) > 1, "Expected multiple chunks for 700+ words"
    # Ensure page numbers are synthetic page numbers (chunk_idx + 1)
    for i, chunk in enumerate(long_chunks):
        assert chunk["page_number"] == i + 1, f"Expected page number {i+1}, got {chunk['page_number']}"
        assert chunk["chunk_index"] == i, f"Expected chunk index {i}, got {chunk['chunk_index']}"
        print(f"  Chunk {i}: Page {chunk['page_number']}, index {chunk['chunk_index']}, char length: {len(chunk['text'])}")

    print("SUCCESS: Text chunking tests passed successfully!\n")

def test_api_connections():
    print("--- Running API Connection Integration Tests ---")
    
    openai_key = os.getenv("OPENAI_API_KEY")
    pinecone_key = os.getenv("PINECONE_API_KEY")
    
    if not openai_key or not pinecone_key:
        print("WARNING: Skipping API connection tests: API keys are missing in .env file.")
        print("Please configure OPENAI_API_KEY and PINECONE_API_KEY to run full tests.")
        return
        
    print("API Keys detected. Initializing RAG Pipeline client connections...")
    try:
        pipeline = RagPipeline()
        pipeline.init_clients()
        print("SUCCESS: RAG Pipeline client initialization routine complete!")
        
        if pipeline.mock_mode:
            print("INFO: Mock Mode is active. Skipping real OpenAI embedding & GPT generation calls.")
            print("Testing Mock Mode RAG answer generation on empty context...")
            response = pipeline.generate_answer("Who are you?", [])
            print(f"Mock Response: {response}")
            assert "I don't have enough information" in response["answer"], "Mock generation failed to follow grounding instructions"
            print("SUCCESS: Mock grounding controls verified.")
        else:
            # Test index presence / creation
            index_name = pipeline.pinecone_index_name
            print(f"Connected to Pinecone index: '{index_name}'")
            
            # Test embedding query
            print("Testing OpenAI embeddings...")
            embeds = pipeline.openai_client.embeddings.create(
                input=["test query"],
                model="text-embedding-3-small"
            )
            assert len(embeds.data[0].embedding) == 1536, "Embedding dimension is not 1536"
            print("SUCCESS: OpenAI embedding generation verified.")

            # Test OpenAI RAG answer generation on empty context
            print("Testing OpenAI GPT RAG prompting on empty context...")
            response = pipeline.generate_answer("Who are you?", [])
            print(f"GPT Response: {response}")
            assert "I don't have enough information" in response["answer"], "GPT failed to follow grounding instructions"
            print("SUCCESS: OpenAI GPT grounding controls verified.")
        
    except Exception as e:
        print(f"ERROR: RAG pipeline integration tests failed with error: {str(e)}")
        sys.exit(1)

    print("SUCCESS: API connection integration tests passed successfully!\n")

if __name__ == "__main__":
    test_text_chunking()
    test_api_connections()
