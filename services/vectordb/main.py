import hashlib
import math
import os
from datetime import datetime, timezone
from typing import Any

import psycopg
import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from psycopg.rows import dict_row
from psycopg.types.json import Json

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://ai:ai@db:5432/ai")
EMBEDDING_DIM = int(os.getenv("EMBEDDING_DIM", "768"))
EMBEDDING_BACKEND = os.getenv("EMBEDDING_BACKEND", "mock").strip().lower()
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://host.docker.internal:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "nomic-embed-text")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_EMBEDDING_MODEL = os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small").strip()
SEARCH_CANDIDATES = int(os.getenv("SEARCH_CANDIDATES", "50"))

app = FastAPI(title="Local pgvector RAG API", version="0.1.0")


class IngestRequest(BaseModel):
    source: str = Field(..., description="Source system, for example confluence or git")
    path: str = Field(..., description="Document identifier or file path")
    text: str = Field(..., min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)
    chunk_size: int = Field(default=1200, ge=200, le=8000)
    chunk_overlap: int = Field(default=200, ge=0, le=2000)


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    limit: int = Field(default=8, ge=1, le=50)
    source: str | None = None
    path: str | None = None
    hybrid: bool = True


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vec))
    if norm == 0:
        return vec
    return [x / norm for x in vec]


def vector_literal(vec: list[float]) -> str:
    return "[" + ",".join(f"{x:.8f}" for x in vec) + "]"


def finalize_embedding(raw_embedding: list[Any], provider_name: str) -> list[float]:
    if not isinstance(raw_embedding, list) or not raw_embedding:
        raise HTTPException(status_code=502, detail=f"{provider_name} did not return a valid embedding")

    embedding = [float(v) for v in raw_embedding]
    if len(embedding) > EMBEDDING_DIM:
        embedding = embedding[:EMBEDDING_DIM]
    elif len(embedding) < EMBEDDING_DIM:
        embedding += [0.0] * (EMBEDDING_DIM - len(embedding))
    return normalize(embedding)


def embed_mock(text: str) -> list[float]:
    vec = [0.0] * EMBEDDING_DIM
    tokens = [tok for tok in text.lower().split() if tok]
    if not tokens:
        tokens = [text.lower()]
    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        for i in range(0, len(digest), 2):
            idx = ((digest[i] << 8) | digest[i + 1]) % EMBEDDING_DIM
            sign = 1.0 if digest[i] % 2 == 0 else -1.0
            vec[idx] += sign * ((digest[i + 1] / 255.0) + 0.25)
    return normalize(vec)


def embed_ollama(text: str) -> list[float]:
    try:
        response = requests.post(
            f"{OLLAMA_URL}/api/embeddings",
            json={"model": OLLAMA_MODEL, "prompt": text},
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Ollama embedding failed: {exc}") from exc
    return finalize_embedding(payload.get("embedding"), "Ollama")


def embed_openai(text: str) -> list[float]:
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is required for EMBEDDING_BACKEND=openai")

    body: dict[str, Any] = {
        "model": OPENAI_EMBEDDING_MODEL,
        "input": text,
    }
    # OpenAI text-embedding-3 models support server-side dimension reduction.
    if OPENAI_EMBEDDING_MODEL.startswith("text-embedding-3"):
        body["dimensions"] = EMBEDDING_DIM

    try:
        response = requests.post(
            f"{OPENAI_BASE_URL}/embeddings",
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json=body,
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OpenAI embedding failed: {exc}") from exc

    data = payload.get("data")
    if not isinstance(data, list) or not data:
        raise HTTPException(status_code=502, detail="OpenAI did not return embedding data")
    first = data[0]
    if not isinstance(first, dict):
        raise HTTPException(status_code=502, detail="OpenAI did not return a valid embedding item")
    return finalize_embedding(first.get("embedding"), "OpenAI")


def embed_text(text: str) -> list[float]:
    if EMBEDDING_BACKEND == "ollama":
        return embed_ollama(text)
    if EMBEDDING_BACKEND == "openai":
        return embed_openai(text)
    return embed_mock(text)


def chunk_text(text: str, size: int, overlap: int) -> list[str]:
    if overlap >= size:
        overlap = max(0, size // 5)
    chunks: list[str] = []
    start = 0
    step = size - overlap
    while start < len(text):
        end = min(len(text), start + size)
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start += step
    return chunks


def chunk_hash(chunk: str) -> str:
    return hashlib.sha256(chunk.encode("utf-8")).hexdigest()


def connect_db() -> psycopg.Connection:
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


@app.get("/health")
def health() -> dict[str, Any]:
    try:
        with connect_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) AS total FROM documents;")
                total = int(cur.fetchone()["total"])
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Database check failed: {exc}") from exc
    return {
        "status": "ok",
        "embedding_backend": EMBEDDING_BACKEND,
        "embedding_dim": EMBEDDING_DIM,
        "documents": total,
        "timestamp": now_utc().isoformat(),
    }


@app.post("/ingest")
def ingest(payload: IngestRequest) -> dict[str, Any]:
    parts = chunk_text(payload.text, payload.chunk_size, payload.chunk_overlap)
    if not parts:
        raise HTTPException(status_code=400, detail="No non-empty chunks to ingest")

    rows = []
    hashes: list[str] = []
    for idx, part in enumerate(parts):
        h = chunk_hash(part)
        hashes.append(h)
        rows.append(
            {
                "source": payload.source,
                "path": payload.path,
                "chunk_index": idx,
                "chunk_hash": h,
                "chunk_text": part,
                "metadata": payload.metadata,
                "embedding": vector_literal(embed_text(part)),
            }
        )

    try:
        with connect_db() as conn:
            with conn.cursor() as cur:
                for row in rows:
                    cur.execute(
                        """
                        INSERT INTO documents
                          (source, path, chunk_index, chunk_hash, chunk_text, metadata, embedding, updated_at)
                        VALUES
                          (%(source)s, %(path)s, %(chunk_index)s, %(chunk_hash)s, %(chunk_text)s, %(metadata)s, %(embedding)s::vector, NOW())
                        ON CONFLICT (source, path, chunk_hash)
                        DO UPDATE SET
                          chunk_index = EXCLUDED.chunk_index,
                          chunk_text = EXCLUDED.chunk_text,
                          metadata = EXCLUDED.metadata,
                          embedding = EXCLUDED.embedding,
                          updated_at = NOW();
                        """,
                        {
                            **row,
                            "metadata": Json(row["metadata"]),
                        },
                    )

                cur.execute(
                    """
                    DELETE FROM documents
                    WHERE source = %s AND path = %s AND NOT (chunk_hash = ANY(%s));
                    """,
                    (payload.source, payload.path, hashes),
                )
            conn.commit()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Ingestion failed: {exc}") from exc

    return {
        "status": "ok",
        "source": payload.source,
        "path": payload.path,
        "chunks": len(parts),
        "embedding_backend": EMBEDDING_BACKEND,
        "timestamp": now_utc().isoformat(),
    }


def vector_search(
    query_embedding: str, limit: int, source: str | None, path: str | None
) -> list[dict[str, Any]]:
    sql = """
      SELECT
        id, source, path, chunk_index, chunk_text, metadata,
        1 - (embedding <=> %s::vector) AS score
      FROM documents
      WHERE (%s::text IS NULL OR source = %s::text)
        AND (%s::text IS NULL OR path = %s::text)
      ORDER BY embedding <=> %s::vector
      LIMIT %s;
    """
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                sql,
                (query_embedding, source, source, path, path, query_embedding, limit),
            )
            rows = cur.fetchall()
    return rows


def hybrid_search(
    query: str, query_embedding: str, limit: int, source: str | None, path: str | None
) -> list[dict[str, Any]]:
    sql = """
      WITH vector_hits AS (
        SELECT
          id, source, path, chunk_index, chunk_text, metadata,
          1 - (embedding <=> %s::vector) AS vector_score,
          ROW_NUMBER() OVER (ORDER BY embedding <=> %s::vector) AS v_rank
        FROM documents
        WHERE (%s::text IS NULL OR source = %s::text)
          AND (%s::text IS NULL OR path = %s::text)
        LIMIT %s
      ),
      text_hits AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            ORDER BY ts_rank_cd(
              to_tsvector('simple', chunk_text),
              plainto_tsquery('simple', %s)
            ) DESC
          ) AS t_rank
        FROM documents
        WHERE (%s::text IS NULL OR source = %s::text)
          AND (%s::text IS NULL OR path = %s::text)
          AND to_tsvector('simple', chunk_text) @@ plainto_tsquery('simple', %s)
        LIMIT %s
      ),
      merged AS (
        SELECT
          v.id, v.source, v.path, v.chunk_index, v.chunk_text, v.metadata,
          COALESCE(1.0 / (60 + v.v_rank), 0) + COALESCE(1.0 / (60 + t.t_rank), 0) AS score
        FROM vector_hits v
        LEFT JOIN text_hits t ON t.id = v.id
        UNION
        SELECT
          d.id, d.source, d.path, d.chunk_index, d.chunk_text, d.metadata,
          COALESCE(1.0 / (60 + t.t_rank), 0) AS score
        FROM text_hits t
        JOIN documents d ON d.id = t.id
        LEFT JOIN vector_hits v ON v.id = t.id
        WHERE v.id IS NULL
      )
      SELECT id, source, path, chunk_index, chunk_text, metadata, score
      FROM merged
      ORDER BY score DESC
      LIMIT %s;
    """

    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                sql,
                (
                    query_embedding,
                    query_embedding,
                    source,
                    source,
                    path,
                    path,
                    SEARCH_CANDIDATES,
                    query,
                    source,
                    source,
                    path,
                    path,
                    query,
                    SEARCH_CANDIDATES,
                    limit,
                ),
            )
            rows = cur.fetchall()
    return rows


@app.post("/search")
def search(payload: SearchRequest) -> dict[str, Any]:
    query_embedding = vector_literal(embed_text(payload.query))
    try:
        if payload.hybrid:
            rows = hybrid_search(
                payload.query,
                query_embedding,
                payload.limit,
                payload.source,
                payload.path,
            )
        else:
            rows = vector_search(
                query_embedding,
                payload.limit,
                payload.source,
                payload.path,
            )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Search failed: {exc}") from exc

    return {
        "status": "ok",
        "query": payload.query,
        "hybrid": payload.hybrid,
        "results": rows,
        "count": len(rows),
        "timestamp": now_utc().isoformat(),
    }
