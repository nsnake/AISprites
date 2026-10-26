package Playcat::AI::Sprites::Editor;

use v5.40;
use experimental qw(signatures);

our $VERSION = '0.10';

# 编辑器适配器注册表：--editor 名字 => 包名
# 新增编辑器（codex / codebuddy / ...）时在这里加一行，并新建对应 .pm
my %EDITORS = (
    claude    => 'Playcat::AI::Sprites::Editor::Claude',
    codebuddy => 'Playcat::AI::Sprites::Editor::CodeBuddy',
);

# 适配器接口（每个 Playcat::AI::Sprites::Editor::* 都必须实现，均为类方法）：
#
#   name()
#       编辑器标识字符串。
#
#   states()
#       支持的状态列表，用于校验 --state。
#
#   infer_state($payload, $explicit_state)
#       $payload 是 stdin 解析出的 hashref；$explicit_state 是 --state 的值。
#       返回要发送的状态；无法推断时返回 undef。

sub available($class) {
    return sort keys %EDITORS;
}

sub load($class, $name = undef) {
    $name = defined $name ? lc("$name") : 'claude';
    $name =~ s/^\s+|\s+$//g;

    my $package = $EDITORS{$name}
        or die sprintf("Unknown editor '%s' (available: %s)\n",
            $name, join(', ', __PACKAGE__->available()));

    (my $path = "$package") =~ s{::}{/}g;
    require "$path.pm";

    return $package;
}

1;
