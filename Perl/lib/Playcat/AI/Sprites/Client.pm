package Playcat::AI::Sprites::Client;

use v5.40;
use experimental qw(signatures);

use Getopt::Long qw(GetOptionsFromArray);
use IO::Socket::UNIX ();
use IO::Socket::INET ();
use JSON::XS ();
use Playcat::AI::Sprites::Config ();
use Socket qw(SOCK_DGRAM);
use Time::HiRes ();
use Playcat::AI::Sprites::Editor;

our $VERSION = '0.11';

use constant {
    DEFAULT_SOCKET   => '/tmp/playcat-ai-sprites.sock',
    DEFAULT_HOST     => '127.0.0.1',
    DEFAULT_UDP_PORT => 8080,
    MAX_MESSAGE      => 8192,
    # 单行上限：O_APPEND 在单行 < PIPE_BUF(4096) 时原子，
    # 超长行截断到 3584 是为元信息字段（ts/raw/state/argv…）留余量。
    MAX_DEBUG_LINE   => 3584,
    # Windows 没有 $ENV{HOME}，退回 USERPROFILE（再不行落当前目录）。
    DEBUG_DEFAULT    => (($ENV{HOME} // $ENV{USERPROFILE} // '.') . '/.playcat-ai-sprites/client-debug.jsonl'),
};

my @MODES = qw(hook send);
my $SEQ   = 0;

# 从 stdin 读编辑器传入的 JSON。终端直连时没有 JSON 可读，
# <STDIN> 会一直等到 EOF，故直接返回空避免卡住。
sub load_payload($class) {
    return {} if -t STDIN;

    my $raw = do { local $/; <STDIN> };
    return {} unless defined $raw && $raw =~ /\S/;
    my $data = eval { JSON::XS->new->utf8->decode($raw) };
    return { raw => $raw } if $@ || ref($data) ne 'HASH';
    $data->{raw} = $raw unless exists $data->{raw};
    return $data;
}

# 调试转储：把 stdin 原文与推断/发送结果落盘成 JSONL，便于事后核对。
# 只在 --debug 时运行；写在主链路之外，任何失败都不影响 hook 语义。
sub dump_debug($self, $raw, $state, $sent, $error) {
    my $path = $self->{debug_file};
    $path = DEBUG_DEFAULT unless defined $path && length $path;
    return unless defined $path && length $path;

    # stdin 原文超长时截断：单行超过 MAX_LINE 会破坏 append 原子性
    # （见设计文档 §5.2）。实测 payload 最长 ~3.1KB，故阈值留到 3584，
    # 既装得下完整事件，又给元信息字段留出余量。
    if (defined($raw) && length($raw) > MAX_DEBUG_LINE) {
        $raw = substr($raw, 0, MAX_DEBUG_LINE) . '...<truncated>';
    }

    # $raw 来自 stdin，是未解码的字节流（无 UTF-8 标志）。
    # 必须先解码成字符，否则 ->utf8->encode 会按 latin1 升级，中文变成 Ã¤Â»Â£。
    my $decoded = eval {
        require Encode;
        Encode::decode('UTF-8', $raw, Encode::FB_CROAK());
    };
    if (!defined $decoded) {
        $decoded = undef;
        $raw     = undef;
    }

    my %fields = (
        ts    => int(Time::HiRes::time() * 1000),
        pid   => $$,
        raw   => $decoded,
        event => $self->{editor}->name,
        state => $state,
        sent  => $sent ? 1 : 0,
        error => $error,
        argv  => \@ARGV,
    );
    $fields{raw_error} = 'undecodable input' unless defined $decoded;

    # 不用 ->utf8：encode 返回字符，由文件句柄的 :encoding(UTF-8) 层落盘。
    # 两者叠加（->utf8 + 编码层）会二次编码成乱码。
    my $line = eval { JSON::XS->new->canonical->encode(\%fields) } or return;

    return unless length($line) < 4096 + 64;

    # append-only：单行 < 4096 字节时 O_APPEND 写入是原子的，
    # 多个 hook 并行触发也不会交错。
    my $dir = $path;
    if ($dir =~ s{/[^/]*$}{}) {
        require File::Path;
        File::Path::make_path($dir);
    }
    open my $fh, '>>:encoding(UTF-8)', $path or return;
    print {$fh} "$line\n";
    close $fh;
}

sub new($class, %args) {
    return bless {
        editor => $args{editor},
        socket => $args{socket} // DEFAULT_SOCKET,
        host   => $args{host}   // DEFAULT_HOST,
        port   => $args{port}   // DEFAULT_UDP_PORT,
        udp        => $args{udp}        ? 1 : 0,
        debug      => $args{debug}      ? 1 : 0,
        debug_file => $args{debug_file},
    }, $class;
}

# 传输层：默认 Unix SOCK_DGRAM；--udp 时走 UDP。
# 两者都是无连接的，send 语义立即返回，适合 hook “发完即走”。
sub open_socket($self) {
    if ($self->{udp}) {
        return IO::Socket::INET->new(
            PeerAddr => $self->{host},
            PeerPort => $self->{port},
            Proto    => 'udp',
            Blocking => 0,
        );
    }
    return IO::Socket::UNIX->new(
        Peer    => $self->{socket},
        Type    => SOCK_DGRAM,
        Blocking => 0,
    );
}

# 组装一条状态消息并发出。失败时静默返回 0，由调用方决定是否提示。
# $payload 是 stdin 解析出的事件；session_id 从中取出带上，显示端靠它区分会话。
sub send_state($self, $state, $source, $payload = undef) {
    return 0 unless defined $state && $state ne '';

    my $msg = {
        editor => $self->{editor}->name,
        state  => $state,
        source => $source,
        seq    => ++$SEQ,
        ts     => int(Time::HiRes::time() * 1000),
    };

    # Codex 用 conversation_id，Claude Code 用 session_id；都没有则不设该键，
    # 服务端补固定 id __manual__，显示端按一个普通会话槽位处理。
    my $session_id = $payload->{session_id} //
                     $payload->{conversation_id} //
                     '';
    $msg->{session_id} = $session_id if length $session_id;

    my $json = eval { JSON::XS->new->utf8->canonical->encode($msg) };
    return 0 if $@ || length($json) > MAX_MESSAGE;

    my $sock = $self->open_socket;
    return 0 unless $sock;

    my $ok = defined $sock->send($json);
    $sock->close;
    return $ok ? 1 : 0;
}

sub run($class, @argv) {
    my $opt = $class->_parse_args(@argv);

    my $editor = Playcat::AI::Sprites::Editor->load($opt->{editor});

    if (defined $opt->{state}) {
        my %valid = map { $_ => 1 } $editor->states;
        unless ($valid{ $opt->{state} }) {
            printf STDERR "Invalid --state '%s' (states: %s)\n",
                $opt->{state}, join(', ', $editor->states);
            return 2;
        }
    }

    my $self = $class->new(
        editor     => $editor,
        socket     => $opt->{socket},
        host       => $opt->{host},
        port       => $opt->{port},
        udp        => $opt->{udp},
        debug      => $opt->{debug},
        debug_file => $opt->{debug_file},
    );

    my $payload = $class->load_payload;
    my $state   = $editor->infer_state($payload, $opt->{state});
    my $mode    = $opt->{mode};

    # send 模式：手动发一个状态，结果反映在退出码里
    if ($mode eq 'send') {
        unless (defined $state && $state ne '') {
            print STDERR "Missing --state\n";
            return 2;
        }
        my $ok = $self->send_state($state, 'manual', $payload);
        printf "%s %s\n", $ok ? 'ok' : 'error', $state;
        return $ok ? 0 : 1;
    }

    # hook 模式：绝不阻塞编辑器，发送失败也一律返回 0
    my $sent = 0;
    $sent = $self->send_state($state, 'hook', $payload) if defined $state;

    # 转储在主链路之后执行：哪怕它失败，hook 也已按语义返回 0
    $self->dump_debug($payload->{raw}, $state, $sent, undef) if $self->{debug};
    return 0;
}

sub _parse_args($class, @argv) {
    my $config_path;
    for (my $i = 0; $i < @argv; $i++) {
        if ($argv[$i] =~ /\A--config=(.+)\z/) {
            $config_path = $1;
        }
        elsif ($argv[$i] eq '--config' && $i + 1 < @argv) {
            $config_path = $argv[ ++$i ];
        }
    }

    # 配置坏了只警告、退回内置默认值：hook 模式必须保持 exit 0
    # 语义（见 run），带着坏配置大声死掉反而违背「绝不阻塞编辑器」。
    my $ccfg = eval {
        Playcat::AI::Sprites::Config->load_section($config_path, 'client')
    };
    if ($@) {
        warn $@;
        $ccfg = {};
    }

    # --state / --mode 属于单次调用的语义，不做进配置文件；
    # 其余键名与命令行长选项一致（- 转 _）。
    my %opt = (
        editor     => $ccfg->{editor} // 'claude',
        socket     => $ccfg->{socket} // DEFAULT_SOCKET,
        host       => $ccfg->{host} // DEFAULT_HOST,
        port       => $ccfg->{port} // DEFAULT_UDP_PORT,
        udp        => $ccfg->{udp} ? 1 : 0,
        mode       => 'hook',
        state      => undef,
        debug      => $ccfg->{debug} ? 1 : 0,
        debug_file => $ccfg->{debug_file} // DEBUG_DEFAULT,
        help       => 0,
    );

    # udp/debug 可否定（--no-udp / --no-debug）：
    # 配置文件里开着时，命令行要能关掉。
    GetOptionsFromArray(
        \@argv,
        'config=s'     => \$config_path,
        'editor=s'     => \$opt{editor},
        'socket=s'     => \$opt{socket},
        'host=s'       => \$opt{host},
        'port=i'       => \$opt{port},
        'udp!'         => \$opt{udp},
        'mode=s'       => \$opt{mode},
        'state=s'      => \$opt{state},
        'debug!'       => \$opt{debug},
        'debug-file=s' => \$opt{debug_file},
        'help'         => \$opt{help},
    ) or $class->_usage(*STDERR, 2);

    $class->_usage(*STDOUT, 0) if $opt{help};

    my %modes = map { $_ => 1 } @MODES;
    $class->_usage(*STDERR, 2) unless $modes{ $opt{mode} };

    return \%opt;
}

sub _usage($class, $fh, $exit_code) {
    my $editors = join(', ', Playcat::AI::Sprites::Editor->available);
    my $socket  = DEFAULT_SOCKET;
    my $host    = DEFAULT_HOST;
    my $port    = DEFAULT_UDP_PORT;
    my $modes   = join(' | ', @MODES);
    my $dbg     = DEBUG_DEFAULT;

    print {$fh} <<"USAGE";
Usage: client.pl [options] < editor-hook-json

Send editor status to Playcat::AI::Sprites::Server via datagram.

Options:
  --editor EDITOR         Editor adapter: $editors (default: claude)
  --config PATH           Config file (JSON, section "client"; see aisprites.json.example)
  --socket PATH           Unix datagram socket (default: $socket)
  --udp                   Use UDP instead of the Unix socket (--no-udp to disable)
  --host HOST             UDP server address (default: $host)
  --port PORT             UDP server port (default: $port)
  --mode MODE             $modes (default: hook)
  --state STATE           Override inferred state (for --mode send)
  --debug                 Dump stdin payload + result to --debug-file (--no-debug to disable)
  --debug-file PATH       Debug dump path (default: $dbg)
  --help                  Show this help

Config: transport options (editor/socket/udp/host/port/debug/debug_file)
may be set in a JSON config file. Search order: --config,
\$ENV{PLAYCAT_AI_SPRITES_CONFIG}, aisprites.json next to client.pl,
~/.playcat-ai-sprites/config.json. Precedence: CLI flags > config > defaults.
USAGE

    exit $exit_code;
}

1;
