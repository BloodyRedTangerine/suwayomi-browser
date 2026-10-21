# Reproducible release build environment: Ubuntu 24.04, x86_64, every tool version and checksum pinned.
# Build:  docker build --platform linux/amd64 -t suwayomi-browser-build docker/
# Run:    see docker/build-in-docker.sh (mounts the source read-only and writes the packages to ./out)
FROM --platform=linux/amd64 ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac

ARG UBUNTU_SNAPSHOT=20261021T000000Z
ARG NODE_VERSION=24.21.0
ARG NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
ARG CMAKE_VERSION=3.31.6
ARG CMAKE_SHA256=5a1133ff103c71eb5120e2cc3de922733e7d8a26a98ae716397e8676adb367bf
ARG NINJA_VERSION=1.13.2
ARG NINJA_ZIP_SHA256=5749cbc4e668273514150a80e387a957f933c6ed3f5f11e03fb30955e2bbead6
ARG TEMURIN_VERSION=21.0.12.1_1
ARG TEMURIN_URL_VERSION=21.0.12.1%2B1
ARG TEMURIN_SHA256=ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94
ARG EMSDK_COMMIT=539e4044b78c3f9ef9c0539b673e48a59ed54803
ARG EMSCRIPTEN_VERSION=4.0.2
ARG PNPM_VERSION=11.1.2
ARG WEB_EXT_VERSION=10.5.0

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
    JAVA_HOME=/opt/temurin \
    EMSDK=/opt/emsdk EMSDK_QUIET=1 \
    PATH=/opt/cmake/bin:/opt/node/bin:/opt/temurin/bin:/opt/ninja:/usr/local/bin:/usr/bin:/bin

# TLS roots first (default archive), then every other OS package from a dated snapshot of the Ubuntu archive, so the OS layer is pinned too.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && printf 'Types: deb\nURIs: https://snapshot.ubuntu.com/ubuntu/%s\nSuites: noble noble-updates noble-security\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n' "${UBUNTU_SNAPSHOT}" > /etc/apt/sources.list.d/ubuntu.sources \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends curl git unzip xz-utils bzip2 python3 build-essential file diffutils findutils \
 && rm -rf /var/lib/apt/lists/*

# Node.js (npm is the version bundled with it)
RUN curl --fail --location --silent --show-error --retry 5 "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum --check --strict \
 && mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 && rm /tmp/node.tar.xz

# CMake
RUN curl --fail --location --silent --show-error --retry 5 "https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-linux-x86_64.tar.gz" -o /tmp/cmake.tar.gz \
 && echo "${CMAKE_SHA256}  /tmp/cmake.tar.gz" | sha256sum --check --strict \
 && mkdir -p /opt/cmake && tar -xzf /tmp/cmake.tar.gz -C /opt/cmake --strip-components=1 && rm /tmp/cmake.tar.gz

# Ninja
RUN curl --fail --location --silent --show-error --retry 5 "https://github.com/ninja-build/ninja/releases/download/v${NINJA_VERSION}/ninja-linux.zip" -o /tmp/ninja.zip \
 && echo "${NINJA_ZIP_SHA256}  /tmp/ninja.zip" | sha256sum --check --strict \
 && mkdir -p /opt/ninja && unzip -q /tmp/ninja.zip -d /opt/ninja && rm /tmp/ninja.zip

# JDK that runs Gradle (the bundled JRE class libraries come from Corretto, fetched and verified by prepare-openjdk.mjs)
RUN curl --fail --location --silent --show-error --retry 5 "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-${TEMURIN_URL_VERSION}/OpenJDK21U-jdk_x64_linux_hotspot_${TEMURIN_VERSION}.tar.gz" -o /tmp/jdk.tar.gz \
 && echo "${TEMURIN_SHA256}  /tmp/jdk.tar.gz" | sha256sum --check --strict \
 && mkdir -p /opt/temurin && tar -xzf /tmp/jdk.tar.gz -C /opt/temurin --strip-components=1 && rm /tmp/jdk.tar.gz

# Emscripten (compiles the WebAssembly JVM)
RUN git clone --quiet https://github.com/emscripten-core/emsdk.git "${EMSDK}" \
 && git -C "${EMSDK}" checkout --quiet "${EMSDK_COMMIT}" \
 && "${EMSDK}/emsdk" install "${EMSCRIPTEN_VERSION}" \
 && "${EMSDK}/emsdk" activate "${EMSCRIPTEN_VERSION}"

# pnpm (version from the Suwayomi-WebUI packageManager field) and the add-on linter
RUN npm install --global --no-audit --no-fund "pnpm@${PNPM_VERSION}" "web-ext@${WEB_EXT_VERSION}" \
 && node --version && npm --version && pnpm --version && web-ext --version \
 && cmake --version | head -1 && ninja --version && java -version 2>&1 | head -1 && git --version

COPY build.sh compare.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/build.sh /usr/local/bin/compare.sh
WORKDIR /build
ENTRYPOINT ["/usr/local/bin/build.sh"]
