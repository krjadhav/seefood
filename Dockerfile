# Thin SeeFood API for the hosted-embedding (Vertex) deployment.
# No model weights: embeddings run in Vertex; this image holds only the ~MB of
# precomputed tables + cosine/routing code.
FROM python:3.11-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    SEEFOOD_EMBED_PROVIDER=vertex

COPY server/requirements-vertex.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Only the server package (datasets, model, backups excluded via .dockerignore).
COPY server/ ./server/

# Cloud Run sets $PORT.
CMD exec uvicorn main:app --app-dir server --host 0.0.0.0 --port ${PORT:-8080}
