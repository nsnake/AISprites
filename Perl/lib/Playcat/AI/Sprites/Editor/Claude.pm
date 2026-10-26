package Playcat::AI::Sprites::Editor::Claude;

use v5.40;
use experimental qw(signatures);

our $VERSION = '0.10';

my @STATES = qw(thinking busy success error alarm off ready idle);

# hook_event_name => LED 状态
# SessionStart 进入 ready：会话已建立但还没开始干活，显示端只占槽位、
# 不画图标（「用到才显示」）。SessionEnd 仍是 off，显示端据此删图标。
# idle_prompt 进入 idle：用户离开约 60 秒，会话还活着，显示端保留槽位
# 画待机图标——它和 SessionEnd 的区别是 idle 可恢复（用户随时会回来）。
my %EVENT_TO_STATE = (
    SessionStart        => 'ready',
    SessionEnd          => 'off',
    UserPromptSubmit    => 'thinking',
    UserPromptExpansion => 'thinking',
    PreToolUse          => 'busy',
    PostToolUse         => 'thinking',
    PostToolBatch       => 'thinking',
    SubagentStart       => 'thinking',
    SubagentStop        => 'thinking',
    TaskCreated         => 'busy',
    TaskCompleted       => 'thinking',
    PreCompact          => 'busy',
    PostCompact         => 'thinking',
    Stop                => 'success',
);

my %NOTIFICATION_TO_STATE = (
    permission_prompt    => 'alarm',
    elicitation_dialog   => 'alarm',
    idle_prompt          => 'idle',
    auth_success         => 'success',
    elicitation_complete => 'thinking',
    elicitation_response => 'thinking',
);

sub name($class)  { 'claude' }
sub states($class) { @STATES }

sub infer_state($class, $payload, $explicit_state = undef) {
    $payload //= {};

    return $explicit_state if defined $explicit_state && $explicit_state ne '';

    my $event = $payload->{hook_event_name} // '';

    # Notification 事件按通知类型细分
    if ($event eq 'Notification') {
        my $type = $payload->{notification_type} // '';
        return $NOTIFICATION_TO_STATE{$type} // 'alarm';
    }

    # Stop 时若仍有后台任务在跑，说明本轮还没真正结束。
    # 注意：Claude Code 在「无后台任务」时发的是空数组 [] 而非缺省，
    # Perl 里 [] 是真值，必须取数组长度判断，否则正常结束也会被判成 busy。
    if ($event eq 'Stop') {
        my $bg     = $payload->{background_tasks} // [];
        my $crons  = $payload->{session_crons}    // [];
        my $active = (ref($bg)    eq 'ARRAY' && @$bg)
                  || (ref($crons) eq 'ARRAY' && @$crons);
        return $active ? 'busy' : 'success';
    }

    # 工具调用失败要显式标红
    if ($event eq 'PostToolUse') {
        my $resp = $payload->{tool_response} // {};
        return 'error' if $resp->{is_error} || $payload->{tool_is_error};
    }

    return $EVENT_TO_STATE{$event};
}

1;
