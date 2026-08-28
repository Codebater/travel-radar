# Travel Radar — production image for the Synology DS723+ (x86_64).
#
# Deliberately a single stage on the full bookworm image rather than a
# multi-stage slim build. The app is tsx-run TypeScript with a native
# better-sqlite3 module and a Python subprocess bridge; a slim runtime would
# need the compiler toolchain copied around for the first and a hand-assembled
# Python for the second, and every one of those seams is a place the container
# can differ from the Windows instance that has been proven for seven phases.
# A NAS with 6.8 TB free does not need a small image; it needs an identical one.
FROM node:22-bookworm

# The fast_flights cash provider shells out to Python (python-bridge.ts probes
# python3 on PATH on Linux). Pinned requirements, PEP 668 override because
# bookworm's system pip refuses otherwise and a container IS the venv.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip3 install --break-system-packages --no-cache-dir -r requirements.txt

# Dependencies first, so a source edit does not re-run npm ci.
# npm ci installs devDependencies too, ON PURPOSE: tsx (the runtime) is a
# devDependency, and this project runs TypeScript directly with no build step.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY . .

# serve.ts writes results.json into the app directory on a manual search, and
# the node user must own what it writes to.
RUN chown -R node:node /app

USER node
ENV HOME=/home/node
# Deliberately NOT setting TZ: every timestamp in this system is UTC by design,
# and quiet hours resolve Europe/Prague explicitly through Intl.

EXPOSE 8888

ENTRYPOINT ["bash", "docker/entrypoint.sh"]
