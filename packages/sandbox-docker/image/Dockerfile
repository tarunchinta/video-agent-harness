# syntax=docker/dockerfile:1.7
#
# The run sandbox: one container per run. Agent-written code, the headless browser, ffmpeg and renders all
# execute here and nowhere else. Architecture: docs/plans/docker-sandbox.md.
#
# Build (the context is this folder, so nothing else in the repo can leak into the image):
#
#   docker build -t harness-sandbox:local packages/sandbox-docker/image
#
# Nothing personal and no secret is baked in or passed at run time. The container gets the run's working
# directory at /work and, when the run allows network access, a proxy address. That is all.

ARG NODE_IMAGE=node:24.21.0-bookworm-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.0
# Static ffmpeg + ffprobe (libx264, libass, loudnorm): about 270 MB, against 400 MB or more for Debian's ffmpeg.
ARG FFMPEG_IMAGE=mwader/static-ffmpeg:7.1

FROM ${UV_IMAGE} AS uv
FROM ${FFMPEG_IMAGE} AS ffmpeg

FROM ${NODE_IMAGE} AS sandbox

ARG PYTHON_VERSION=3.12
ARG PLAYWRIGHT_VERSION=1.65.1
# Bumped whenever the scripts in bin/ or the paths below change in a way the driver depends on.
# The driver refuses to start a container from an image with a different value.
ARG SANDBOX_API=1

LABEL harness.sandbox.api="${SANDBOX_API}"

ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    # Extra Python packages go to /work/.packages so they survive a restart (see docs/plans/docker-sandbox.md).
    PYTHONPATH=/work/.packages \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/matplotlib \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy \
    PLAYWRIGHT_BROWSERS_PATH=/opt/browsers \
    # Node's fetch and http(s) clients follow HTTP_PROXY / HTTPS_PROXY / NO_PROXY, like curl and Python do.
    NODE_USE_ENV_PROXY=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    LANG=C.UTF-8

# Command-line basics, and fonts: without them charts, captions and web pages render as boxes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq unzip xz-utils procps \
      fontconfig fonts-liberation fonts-noto-core fonts-noto-color-emoji fonts-inter \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/*

COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
COPY --from=uv /uv /uvx /usr/local/bin/

# Python for research experiments and charts: a root-owned baseline the run cannot change.
COPY requirements.txt /opt/sandbox/requirements.txt
RUN --mount=type=cache,id=harness-sandbox-uv,target=/root/.cache/uv \
    UV_PYTHON_DOWNLOADS=automatic uv python install "${PYTHON_VERSION}" \
 && uv venv --python "${PYTHON_VERSION}" /opt/venv \
 && uv pip install --python /opt/venv/bin/python --compile-bytecode -r /opt/sandbox/requirements.txt

# Playwright and Chromium (with the headless shell), plus the system libraries and Xvfb they need.
# The package lives in /opt/node and is linked at /node_modules, so `import "playwright"` resolves from any
# script under /work without an install.
RUN mkdir -p /opt/node && cd /opt/node \
 && npm init -y >/dev/null \
 && npm install --no-audit --no-fund --loglevel=error "playwright@${PLAYWRIGHT_VERSION}" \
 && ln -s /opt/node/node_modules /node_modules \
 && npx playwright install --with-deps chromium \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/* /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* \
 && chmod -R a+rX /opt/browsers

# Word timings for an uploaded voiceover: faster-whisper and one model, both fixed at build time because a run
# has no network by default. Kept in its own layer, after the browser, so changing it does not download Chromium
# again. The model is about 480 MB; pass --build-arg WHISPER_MODEL=base.en for a smaller, less exact one.
ARG WHISPER_MODEL=small.en
COPY requirements-voice.txt /opt/sandbox/requirements-voice.txt
RUN --mount=type=cache,id=harness-sandbox-uv,target=/root/.cache/uv \
    UV_HTTP_TIMEOUT=120 uv pip install --python /opt/venv/bin/python --compile-bytecode -r /opt/sandbox/requirements-voice.txt \
 && HF_HOME=/tmp/hf python -c "from faster_whisper.utils import download_model; download_model('${WHISPER_MODEL}', output_dir='/opt/whisper/model')" \
 && rm -rf /tmp/hf /opt/whisper/model/.cache \
 && chmod -R a+rX /opt/whisper
ENV HARNESS_WHISPER_MODEL=/opt/whisper/model \
    HF_HUB_OFFLINE=1

# The sandbox user (uid 1000). On a Linux host the driver runs the container as the host user instead, so that
# files in /work stay owned by the person running the harness; home and the pid folder are therefore open.
RUN userdel -r node 2>/dev/null || true \
 && groupadd --gid 1000 sandbox \
 && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/sandbox --shell /bin/bash sandbox \
 && mkdir -p /work /artifacts /cache /run/sandbox \
 && chown sandbox:sandbox /work \
 && chmod 0777 /home/sandbox \
 && chmod 1777 /run/sandbox /cache

COPY --chmod=755 bin/ /usr/local/bin/
COPY egress-proxy.mjs /opt/sandbox/egress-proxy.mjs
# A checkout made with Git for Windows can carry CRLF line endings, which breaks scripts ("/bin/sh^M").
RUN sed -i 's/\r$//' /usr/local/bin/sandbox-exec /usr/local/bin/sandbox-kill /usr/local/bin/sandbox-selfcheck \
      /opt/sandbox/egress-proxy.mjs

ENV HOME=/home/sandbox
USER sandbox
WORKDIR /work

# Fail the build, not a run, when a tool is missing or the browser cannot start.
RUN sandbox-selfcheck

# The container idles; all work arrives through `docker exec`. The driver starts it with --init.
CMD ["sleep", "infinity"]
