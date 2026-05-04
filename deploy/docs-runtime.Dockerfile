FROM caddy:2-alpine

COPY docs/.vitepress/dist /srv
COPY deploy/docs.Caddyfile /etc/caddy/Caddyfile

EXPOSE 80
