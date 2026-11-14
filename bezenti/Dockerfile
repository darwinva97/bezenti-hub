# Imagen del Hub de bezenti (claude.bezenti.com, clúster k3s de infra-contabo).
#
# Dos etapas:
#   compilar  Debian 12 + Vite+ (vp, que trae Node 26.12.1 y pnpm) + Rust. Compila el servidor y la web
#             y empaqueta la CLI `t3` autocontenida para Linux x64 EXACTAMENTE como la publica el CI
#             (scripts/build-cli-archive.ts): ejecutable único de Node 26.12.1 + client/ + node_modules
#             nativos + resource-monitor + sandbox-image/. La etapa `archivo` saca ese .tar.gz para la
#             Release de GitHub, de modo que el Hub y la VPS dedicada ejecutan el mismo binario.
#   hub       Debian 12 slim con ese mismo árbol en /opt/t3, git, ssh, certificados y util-linux.
#             Usuario sin root (1000:1000). Sin Chromium (el Hub no ejecuta agentes ni navegador).
#
# Se compila sobre Debian 12 (glibc 2.36) a propósito: node-pty se compila aquí desde el código y el
# mismo árbol corre en la VPS (Debian 12) y dentro de la imagen del Sandbox (debian:bookworm-slim).
#
# Uso (desde la raíz del repo):
#   docker buildx build -f bezenti/Dockerfile --build-arg T3_VERSION=0.1.7-bezenti.1 --target hub -t hub .
#   docker buildx build -f bezenti/Dockerfile --build-arg T3_VERSION=0.1.7-bezenti.1 --target archivo -o salida .

FROM docker.io/library/debian:bookworm AS compilar

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl file git jq libatomic1 patchelf pkg-config python3 unzip xz-utils \
 && rm -rf /var/lib/apt/lists/*

# Rust: solo para native/resource-monitor (lo lleva el archivo de la CLI).
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup.sh \
 && sh /tmp/rustup.sh -y --profile minimal --default-toolchain stable --no-modify-path \
 && rm /tmp/rustup.sh

# Vite+ (vp) en la versión del catálogo (pnpm-workspace.yaml). VP_NODE_VERSION fija Node para TODO
# (apps/server declara un rango y vp elegiría la última; el ejecutable único exige 26.12.1 exacto).
ARG VP_VERSION=1.4.0
ENV VP_HOME=/opt/vite-plus VP_NODE_VERSION=26.12.1
ENV PATH=/opt/vite-plus/bin:/opt/cargo/bin:$PATH
RUN curl -fsSL https://vite.plus -o /tmp/vp.sh \
 && VP_VERSION="$VP_VERSION" VP_NODE_MANAGER=yes bash /tmp/vp.sh \
 && rm /tmp/vp.sh \
 && vp --version

WORKDIR /src
COPY . .
# `vp install` ejecuta el `prepare` del repo (vp config), que espera un repositorio git.
RUN git init -q . && node --version

RUN vp install --filter=t3... --filter=@t3tools/scripts...

RUN cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml \
 && mkdir -p /tmp/resource-monitor/linux-x64 \
 && cp native/resource-monitor/target/release/t3-resource-monitor /tmp/resource-monitor/linux-x64/

# La versión va después de instalar (el script necesita las dependencias), como en release.yml.
ARG T3_VERSION
RUN test -n "$T3_VERSION" || { echo "Falta --build-arg T3_VERSION" >&2; exit 1; } \
 && node scripts/update-release-package-versions.ts "$T3_VERSION"

# Mismos pasos que release.yml / release-desktop.yml del original para Linux x64.
RUN vp run --filter t3 build \
 && node scripts/apply-web-brand-assets.ts production apps/server/dist/client \
 && node apps/server/scripts/cli.ts build-exe --verbose \
 && node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$T3_VERSION" \
      --resource-monitor-dir /tmp/resource-monitor --output-dir /salida \
 && node scripts/smoke-cli-archive.ts --archive "/salida/t3-${T3_VERSION}-linux-x64.tar.gz" \
      --expect-version "$T3_VERSION"

# Solo el archivo, para `--target archivo -o <dir>` (lo sube el CI a la Release).
FROM scratch AS archivo
COPY --from=compilar /salida/ /

FROM docker.io/library/debian:bookworm-slim AS hub

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client tini util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 t3 \
 && useradd -u 1000 -g 1000 -d /home/t3 -m -s /usr/sbin/nologin t3

ARG T3_VERSION
COPY --from=compilar /salida/t3-${T3_VERSION}-linux-x64.tar.gz /tmp/t3.tar.gz
RUN mkdir -p /opt/t3 \
 && tar -xzf /tmp/t3.tar.gz -C /opt/t3 --strip-components=1 --no-same-owner \
 && rm /tmp/t3.tar.gz \
 && ln -s /opt/t3/t3 /usr/local/bin/t3 \
 && test "$(t3 --version)" = "t3 v$T3_VERSION"

LABEL org.opencontainers.image.source="https://github.com/darwinva97/bezenti-hub" \
      org.opencontainers.image.description="Hub de bezenti (T3 Code Hub)" \
      org.opencontainers.image.version="${T3_VERSION}"

# Estado en T3CODE_HOME (un volumen). Los Sandboxes NO corren en el Hub: van en la VPS dedicada.
ENV T3CODE_HOME=/datos \
    T3CODE_HOST=0.0.0.0 \
    T3CODE_PORT=3773 \
    T3CODE_NO_BROWSER=1 \
    T3CODE_SANDBOX_RUNTIME=off \
    HOME=/home/t3

# arranque.sh saca de los logs el token de emparejamiento de cada arranque (ver el script).
# tini -g: las señales van a todo el grupo (t3 y el filtro), así t3 se apaga limpio.
COPY --chmod=0755 bezenti/arranque.sh /usr/local/bin/bezenti-arranque

USER 1000:1000
WORKDIR /home/t3
EXPOSE 3773
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/bezenti-arranque"]
CMD ["serve"]
