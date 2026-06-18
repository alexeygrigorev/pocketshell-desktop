# tmux layer: extends the base ssh image with tmux, for attach/terminal tests.
FROM pocketshell-test:ssh

RUN apk add --no-cache tmux
