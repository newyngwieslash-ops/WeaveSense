# Both the base digest and the npm integrity pin are upgraded through contract tests.
FROM public.ecr.aws/docker/library/node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS artifact
ARG OPENCODE_VERSION=1.3.13
RUN test "$OPENCODE_VERSION" = "1.3.13"
RUN node --input-type=module -e 'import{writeFileSync}from"node:fs";import{createHash}from"node:crypto";const u="https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-1.3.13.tgz";const r=await fetch(u);if(!r.ok)throw Error("artifact_fetch_failed");const b=Buffer.from(await r.arrayBuffer());if(createHash("sha512").update(b).digest("base64")!=="zL+gG/TnevdTgbc6z3RwYXIpaodmdt2IqHF+CAQuf8Ayzx1LF0SvkkiclIEz12kdjlfttjNOxuRFWCJLzQIJIw==")throw Error("artifact_integrity_mismatch");writeFileSync("/tmp/opencode.tgz",b)' \
    && tar xzf /tmp/opencode.tgz -C /tmp \
    && install -m 0755 /tmp/package/bin/opencode /usr/local/bin/opencode \
    && rm -rf /tmp/package /tmp/opencode.tgz

FROM public.ecr.aws/docker/library/node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS runtime
LABEL org.opencontainers.image.title="WeaveSense OpenCode research runtime" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="1.3.13"
COPY --from=artifact /usr/local/bin/opencode /usr/local/bin/opencode
COPY workers/opencode-runtime/server.mjs /opt/runtime/server.mjs
COPY workers/agent/skills/industry-analysis /opt/skills/industry-analysis
COPY workers/agent/skills/cross-source-check /opt/skills/cross-source-check
COPY workers/agent/skills/briefing-writing /opt/skills/briefing-writing
COPY workers/agent/skills/project-assistant /opt/skills/project-assistant
RUN mkdir /state && chown node:node /state
USER node
WORKDIR /opt/runtime
EXPOSE 4097
# Compose must provide init, read_only, cap_drop, no-new-privileges and /state tmpfs.
CMD ["node", "/opt/runtime/server.mjs"]

FROM runtime AS probe
COPY scripts/opencode-contract-probe.mjs /opt/probe/scripts/opencode-contract-probe.mjs
COPY validation/agent/opencode/config.fixture.json /opt/probe/validation/agent/opencode/config.fixture.json
COPY workers/agent/skills/industry-analysis /opt/probe/workers/agent/skills/industry-analysis
COPY workers/agent/skills/cross-source-check /opt/probe/workers/agent/skills/cross-source-check
COPY validation/agent/opencode/isolation.fixture.mjs /opt/probe/isolation.fixture.mjs
ENV OPENCODE_PROBE_BINARY=/usr/local/bin/opencode
CMD ["node", "/opt/probe/scripts/opencode-contract-probe.mjs", "--offline"]

FROM runtime AS production
