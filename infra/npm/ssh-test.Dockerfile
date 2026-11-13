# Disposable integration-test server only. Never part of the deployment Compose.
FROM anticlone-pilot:test
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd && passwd -d root
ENTRYPOINT ["/usr/sbin/sshd", "-D", "-e", "-f", "/fixture/sshd_config"]
