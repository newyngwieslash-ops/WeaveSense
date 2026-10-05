FROM python:3.12-slim@sha256:dddfd7e07f9d15aeeca61529320492139d21cac7f0070c00609243e51e4e0016
ARG SOURCE_SHA=unversioned
LABEL org.opencontainers.image.revision=$SOURCE_SHA
WORKDIR /app
RUN mkdir -p /data
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && pip check
COPY server.py login.py ./
ENV PORT=8787 PYTHONUNBUFFERED=1
EXPOSE 8787
CMD ["python", "server.py"]
