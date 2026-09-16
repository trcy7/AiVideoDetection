# ECNet inference server.
#   CPU:  docker build -t ecnet .
#   GPU:  docker build -t ecnet --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu121 .
FROM python:3.11-slim

# ffmpeg/ffprobe power the HDR->SDR tonemap in server.py (it degrades silently
# without them); curl fetches the checkpoint at first boot.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
COPY requirements-serve.txt .
RUN pip install --no-cache-dir --extra-index-url "$TORCH_INDEX" -r requirements-serve.txt

COPY src/ ./src/
COPY configs/ ./configs/
COPY docker-entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint

# 0.0.0.0 or the container is unreachable; $PORT is injected by most PaaS.
ENV ECNET_HOST=0.0.0.0 \
    PORT=8000 \
    ECNET_CHECKPOINT=/models/ECNet-7.pt \
    ECNET_DB=/data/ecnet.db \
    PYTHONUNBUFFERED=1

# Persist the audit trail + feedback across restarts.
VOLUME ["/models", "/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

ENTRYPOINT ["entrypoint"]
CMD ["--db", "/data/ecnet.db"]
