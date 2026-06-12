# Release Checklist — v0.1.0

Pre-release checklist for PocketShell Desktop v0.1.0. Based on the release criteria defined in [plan.md](plan.md).

## Release Criteria

### Connection & Terminal

- [ ] App launches on Windows and auto-connects to configured host
- [ ] SSH connection succeeds with password and key-based authentication
- [ ] Host CRUD works: add, edit, delete, list hosts
- [ ] SSH config file import works
- [ ] Integrated terminal renders output and forwards input
- [ ] Terminal resize events propagate correctly
- [ ] tmux control mode client connects and parses session state
- [ ] tmux sessions, windows, and panes render correctly
- [ ] tmux session creation, window splitting, pane navigation work
- [ ] tmux detach and re-attach work

### Remote File Access

- [ ] File browser works: can navigate remote filesystem, view/edit files
- [ ] Directory listing shows file type, size, and permissions
- [ ] File viewer displays file contents in Monaco Editor (read-only mode)
- [ ] File editor saves changes back to remote host via SFTP
- [ ] File watcher detects remote file changes
- [ ] Git repository browsing works via `pocketshell repos`
- [ ] Git status, log, branch, and blame commands parse correctly

### Agent Awareness

- [ ] Agent detection works: Claude Code detected in tmux pane
- [ ] Codex and OpenCode agents also detected
- [ ] Conversation view works: can read agent conversation
- [ ] Conversation parsers handle all supported agent log formats
- [ ] Reply-in-place works: can send a message to the agent
- [ ] Reply queue delivers messages in order
- [ ] Slash command palette discovers and executes agent commands
- [ ] Fuzzy matching finds commands by partial input
- [ ] Agent hooks can be installed and their status checked

### PocketShell Integration

- [ ] `pocketshell usage` output parses and displays correctly
- [ ] `pocketshell jobs` lists and manages remote jobs
- [ ] `pocketshell env` shows environment variables
- [ ] `pocketshell logs` streams and displays session logs
- [ ] Bootstrap detects if `pocketshell` CLI is installed on remote host
- [ ] Bootstrap assists with CLI installation or upgrade
- [ ] Version checker flags incompatible CLI versions

### Testing

- [ ] All unit tests pass (`npm test`)
- [ ] All critical E2E scenarios pass against Docker fixture (`npx playwright test`)
- [ ] Docker SSH fixture builds and starts cleanly

### CI

- [ ] CI green on Windows (`windows-latest`)
- [ ] CI green on macOS (`macos-latest`, `macos-13`)
- [ ] CI green on Linux (`ubuntu-latest`)
- [ ] E2E tests pass in CI against Docker fixture

### Distribution

- [ ] Windows installer produced (`.exe` or `.msi`)
- [ ] macOS build produced (`.dmg` for arm64 and x64)
- [ ] Linux build produced (`.tar.gz` or `.deb`)

## Version Bump

- [ ] Update `package.json` version to `0.1.0`
- [ ] Verify `product.json` has correct branding and quality `stable`
- [ ] Update `CHANGELOG.md` with release date
- [ ] Verify all docs reference correct version

## Tag and Release

1. [ ] Commit version bump: `git commit -m "chore: bump version to 0.1.0"`
2. [ ] Create annotated tag: `git tag -a v0.1.0 -m "PocketShell Desktop v0.1.0"`
3. [ ] Push commit: `git push origin main`
4. [ ] Push tag: `git push origin v0.1.0`
5. [ ] Verify CI release workflow triggers on the tag
6. [ ] Verify all four platform builds succeed (win32-x64, darwin-arm64, darwin-x64, linux-x64)
7. [ ] Verify GitHub Release is created with artifacts attached
8. [ ] Edit GitHub Release body with release notes from [release-notes-v0.1.0.md](release-notes-v0.1.0.md)
9. [ ] Mark the release as latest

## Post-Release

- [ ] Verify download links work on the GitHub Release page
- [ ] Test installer on a clean Windows machine
- [ ] Announce release (if applicable)
