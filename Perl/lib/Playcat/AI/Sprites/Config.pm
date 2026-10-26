package Playcat::AI::Sprites::Config;

# 共享配置加载：server.pl / client.pl 都从这里读配置文件。
#
# 查找顺序（取第一个存在的）：
#   1. --config PATH 显式指定
#   2. 环境变量 PLAYCAT_AI_SPRITES_CONFIG
#   3. 脚本所在目录的 aisprites.json（可随仓库/部署目录一起分发）
#   4. ~/.playcat-ai-sprites/config.json（用户级配置）
#
# 文件格式（JSON，键名与命令行长选项对应，- 转 _）：
#   {
#     "server": { "udp_port": 7788, ... },
#     "client": { "udp": true, "host": "127.0.0.1", ... }
#   }
#
# 优先级：命令行显式参数 > 配置文件 > 内置默认值。

use v5.40;
use experimental qw(signatures);

use FindBin ();
use JSON::XS ();

our $VERSION = '0.01';

use constant ENV_KEY => 'PLAYCAT_AI_SPRITES_CONFIG';

# Windows 没有 $ENV{HOME}，退回 USERPROFILE（再不行落当前目录）。
# 允许方法调用（$class->home_dir）与函数调用（home_dir()）两种形式。
sub home_dir($class = undef) {
    return $ENV{HOME} // $ENV{USERPROFILE} // '.';
}

sub default_paths($class = undef) {
    return (
        "$FindBin::Bin/aisprites.json",
        home_dir() . '/.playcat-ai-sprites/config.json',
    );
}

# 加载并合并配置。返回整个文件解析出的 hash（含 server/client 等
# section），没有任何可用文件时返回空 hash。
# 显式指定的 --config 不存在或内容不合法时抛错（die）：
# 用户点名要的文件坏了应当大声失败，静默回退默认值只会让
# 排障变成猜谜。
sub load($class, $explicit = undef) {
    my @candidates;
    if (defined $explicit && length $explicit) {
        @candidates = ($explicit);
    }
    elsif (defined $ENV{ENV_KEY()} && length $ENV{ENV_KEY()}) {
        @candidates = ($ENV{ENV_KEY()});
    }
    else {
        @candidates = $class->default_paths;
    }

    for my $path (@candidates) {
        next unless defined $path && length $path && -f $path;

        open my $fh, '<', $path or die "config: cannot read $path: $!\n";
        local $/;
        my $raw = <$fh>;
        close $fh;

        my $data = eval { JSON::XS->new->utf8->decode($raw) };
        die "config: invalid JSON in $path: $@\n" if $@;
        die "config: top level of $path must be an object\n"
            if !defined $data || ref($data) ne 'HASH';

        return $data;
    }

    if (defined $explicit && length $explicit) {
        die "config: file not found: $explicit\n";
    }

    return {};
}

# load() + 取出指定 section。section 缺失返回空 hash；
# section 存在但不是 object 时抛错。
sub load_section($class, $explicit = undef, $section = undef) {
    my $cfg    = $class->load($explicit);
    my $sec    = defined $section ? $cfg->{$section} : undef;
    return {} unless defined $sec;
    die "config: section '$section' must be an object\n"
        if ref($sec) ne 'HASH';
    return $sec;
}

1;
