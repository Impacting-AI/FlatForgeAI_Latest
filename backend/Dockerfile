FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 MPLBACKEND=Agg FLATFORGE_DATA=/data
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglu1-mesa libxrender1 libxext6 libsm6 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY flatforge ./flatforge
RUN useradd --uid 10001 --create-home flatforge && mkdir -p /data && chown flatforge:flatforge /data
USER flatforge
EXPOSE 8000
CMD ["uvicorn","flatforge.api:app","--host","0.0.0.0","--port","8000","--workers","2"]
