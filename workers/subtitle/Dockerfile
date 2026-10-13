FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS node
FROM python:3.12.14-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /opt/subtitle
COPY requirements.txt ./requirements.txt
RUN python -m pip --isolated --disable-pip-version-check install --no-cache-dir --only-binary=:all: --no-deps --index-url https://pypi.org/simple -r requirements.txt
COPY server.py ./server.py
USER 1000:1000
ENV PYTHONDONTWRITEBYTECODE=1
CMD ["python", "-I", "/opt/subtitle/server.py"]
