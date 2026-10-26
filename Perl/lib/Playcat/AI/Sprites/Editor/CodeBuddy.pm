package Playcat::AI::Sprites::Editor::CodeBuddy;

use v5.40;
use experimental qw(signatures);

our $VERSION = '0.10';

my @STATES = qw(thinking busy success error alarm off ready idle);

# hook_event_name => LED 状态
# 状态语义与 Claude 适配器完全一致——状态图标各编辑器通用，角标才区分编辑器。
# CodeBuddy 2.127.2 实测 27 个事件，这里只映射有显示语义的那些；ConfigChange /
# InstructionsLoaded / Setup / FileChanged / CwdChanged 是环境事件，FinalStop 是
# 内部事件，TeammateIdle 的 session_id 归属未验证，都不映射——返回 undef，
# Client.pm 据此不发消息（比猜错状态更安全）。
my %EVENT_TO_STATE = (
    SessionStart       => 'ready',
    SessionEnd         => 'off',
    UserPromptSubmit   => 'thinking',
    PreToolUse         => 'busy',
    PostToolUse        => 'thinking',
    PostToolUseFailure => 'error',
    PreCompact         => 'busy',
    PostCompact        => 'thinking',
    SubagentStart      => 'thinking',
    SubagentStop       => 'thinking',
    TaskCreated        => 'busy',
    TaskCompleted      => 'thinking',
    Stop               => 'success',
    StopFailure        => 'error',
    PermissionRequest  => 'alarm',
    PermissionDenied   => 'error',
    Elicitation        => 'alarm',
    ElicitationResult  => 'thinking',
);

# Notification 按通知类型细分。CodeBuddy 实测只有下面 5 种类型
# （没有 Claude 的 elicitation_response），未知类型一律按 alarm 处理。
my %NOTIFICATION_TO_STATE = (
    permission_prompt    => 'alarm',
    elicitation_dialog   => 'alarm',
    idle_prompt          => 'idle',
    auth_success         => 'success',
    elicitation_complete => 'thinking',
);

sub name($class)   { 'codebuddy' }
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

    # stop_hook_active 为真说明 Stop hook 让 agent 继续干活，本轮还没真正结束。
    # CodeBuddy 的 Stop 载荷没有 Claude 那样的 background_tasks 字段，只有这个标志。
    if ($event eq 'Stop') {
        return $payload->{stop_hook_active} ? 'busy' : 'success';
    }

    # 工具调用失败要显式标红。tool_response 可能是字符串，先确认是 hashref 再取键，
    # 否则「当成 hash 解引用」会在 hook 里抛异常。
    if ($event eq 'PostToolUse') {
        my $resp = $payload->{tool_response};
        return 'error' if ref($resp) eq 'HASH'
                       && ($resp->{is_error} || $resp->{isError});
    }

    return $EVENT_TO_STATE{$event};
}

1;
