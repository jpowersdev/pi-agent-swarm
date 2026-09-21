FROM node:26-alpine

RUN apk add --no-cache git
COPY guest-init /sbin/swarm-guest-init
RUN chmod 0755 /sbin/swarm-guest-init \
  && mkdir -p /workspace /tmp /run
