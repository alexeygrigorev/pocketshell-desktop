FROM alpine:latest

RUN apk add --no-cache \
    openssh-server \
    openssh-client \
    tmux \
    bash \
    sqlite \
    git \
    procps

ARG PS_VERSION=0.0.0
ENV PS_VERSION=$PS_VERSION

RUN adduser -D -s /bin/sh testuser && \
    mkdir -p /home/testuser/.ssh && \
    ssh-keygen -A

COPY sshd_config /etc/ssh/sshd_config
COPY test_key.pub /home/testuser/.ssh/authorized_keys
COPY test_key /root/test_key
RUN chmod 600 /root/test_key && \
    chown testuser:testuser /home/testuser/.ssh/authorized_keys && \
    chmod 600 /home/testuser/.ssh/authorized_keys

COPY agent-bin/ /usr/local/bin/
RUN chmod +x /usr/local/bin/*

COPY agent-fixtures/ /opt/pocketshell-agent-fixtures/

COPY agent-entrypoint.sh /usr/local/bin/agent-entrypoint
RUN chmod +x /usr/local/bin/agent-entrypoint

HEALTHCHECK --interval=2s --timeout=5s --retries=10 --start-period=5s \
    CMD ssh -o BatchMode=yes -o ConnectTimeout=2 -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null -i /root/test_key testuser@localhost true || exit 1

EXPOSE 22

ENTRYPOINT ["agent-entrypoint"]
