# 测试环境卫生（tmux 测试库）

## 决策：测试 server 必须 env 净化
- tmux server 启动时把首个 client 的 environ 复制进全局 env；`opencode serve` 会把其全局 env 快照吸进所有后代 shell（gt-ef79 实证）。
- 因此任何「驱动 shell → tests/run-all.sh」血统都可能给测试 server 带入 `TMUX_AGENT_*` 污染键，使环境敏感断言（如 fallback 测试的 `assert_empty`）随驱动血统红绿不一。
- `tests/lib/tmux-test-lib.sh` 的 `sanitize_inherited_env` 在 `new-session` 后一次性 `set-environment -gu` 掉全部 `^TMUX_AGENT` 键——库级一次护全部测试，勿在单测里打补丁。
- 回归钉写法：污染驱动 = 带 `TMUX_AGENT_PANE_%0_*` 键跑 run-all；净化驱动 = `env -u` 剥全部 TMUX_AGENT_* 键跑 run-all；两组必须同绿。

## Bug 教训：tmux -L socket 目录不得硬编码 /tmp
- tmux 把 `-L` socket 放在 `${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/`；`env -u TMUX` 只清 `TMUX`，不清 `TMUX_TMPDIR`。
- 定位/清理 socket 一律用 lib 顶层的 `TMUX_SOCKET_DIR`；硬编码 `/tmp/tmux-$(id -u)` 在 TMUX_TMPDIR 设置的血统下静默失效（gt-2e1c 评审 O1/O2）。

## 泄漏 socket 清扫约定
- 只清 `agent-test-*` 前缀、`-type s`、mtime>1h（防误杀并发套件）；永不碰 `default`。
- sweep 挂在 `setup_test_server` 首行而非 source 时——lib 被 source 必须零副作用。
