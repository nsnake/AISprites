package Playcat::AI::Sprites::Server;

use v5.40;

use Mojo::Base 'Mojolicious';

use Getopt::Long qw(GetOptionsFromArray);
use IO::Socket::UNIX ();
use IO::Socket::INET ();
use JSON::XS ();
use Mojo::IOLoop;
use Playcat::AI::Sprites::Config ();
use Socket qw(SOCK_DGRAM);

our $VERSION = '0.12';

use constant {
    DEFAULT_SOCKET    => '/tmp/playcat-ai-sprites.sock',
    DEFAULT_UDP_ADDR  => '0.0.0.0',
    DEFAULT_UDP_PORT  => 8080,
    DEFAULT_HTTP_HOST => '0.0.0.0',
    DEFAULT_HTTP_PORT => 3000,
    MAX_DGRAM         => 8192,
    # 会话表默认上限，与 ESP32 的 MAX_SESSIONS 对齐。服务端先挡一道，
    # 固件就不会遇到满表丢弃可见会话的情况。可用 --max-sessions 覆盖。
    DEFAULT_MAX_SESSIONS => 8,
    # 0 表示不限，只有显式 --max-sessions 0 才会取到这个含义。
    UNLIMITED_SESSIONS   => 0,
};

# 手动 --mode send 发出的消息没有 session_id，统一补这个固定 id，
# 显示端当作一个普通槽位处理，便于验证链路。
use constant MANUAL_SESSION_ID => '__manual__';

has socket_path  => sub { DEFAULT_SOCKET };
has udp_addr     => sub { DEFAULT_UDP_ADDR };
has udp_port     => sub { DEFAULT_UDP_PORT };
has subscribers  => sub { {} };
has last_message => sub { undef };
# 会话表：session_id => { state, ts, last_msg }
# 只记账，不做任何选择——显示端自己维护多会话状态。
# 注意：不能叫 sessions，Mojolicious::Controller 有同名访问器（会话机制），
# 覆盖它会让渲染进入 exception 模版并使 reactor 空转（CPU 满载）。
has session_table => sub { {} };
# 会话表上限。默认 8（与 ESP32 的 MAX_SESSIONS 对齐）；--max-sessions 0 表示不限。
# 调高并不会让屏幕多显示：固件按 4x2 网格布局，超过它自己的上限仍会丢弃。
has max_sessions => sub { DEFAULT_MAX_SESSIONS };

sub startup {
    my ($self) = @_;

    my $r = $self->routes;

    $r->get('/' => sub {
        my ($c) = @_;
        my $last = $self->last_message;
        # 注意：这里必须用 $self->session_table（app 属性）而非 $c->sessions——
        # 后者是 Mojolicious 的会话机制，触发 stash 保留键后会让渲染进入
        # exception 模版并使 reactor 空转（CPU 满载）。
        my $sessions = $self->session_table;
        my @lines = (
            "Playcat AI Sprites server ok",
            sprintf("clients: %d", scalar(keys %{$self->subscribers})),
            sprintf("sessions: %d", scalar(keys %$sessions)),
            sprintf("last: %s", defined $last ? JSON::XS->new->utf8->encode($last) : 'none'),
        );
        $c->render(text => join("\n", @lines) . "\n");
    });

    $r->get('/state' => sub {
        my ($c) = @_;
        my $last = $self->last_message;
        $c->render(json => (defined $last ? $last : { state => undef }));
    });

    # ESP32 / 任何 WS 客户端订阅这里，收到状态消息即点亮
    $r->websocket('/ws' => sub {
        my ($c) = @_;
        my $tx = $c->tx;
        my $id = $tx->connection;

        $self->subscribers->{$id} = $tx;
        $c->on(finish => sub { delete $self->subscribers->{$id} });

        # 重连时推一次全量快照，显示端据此重建多会话状态；
        # 单条 last_message 只够还原一个会话，快照才能还原全部图标。
        my $snapshot = $self->build_snapshot;
        $tx->send(JSON::XS->new->utf8->encode($snapshot)) if defined $snapshot;
    });
}

# 建 Unix + UDP 双 listener 并挂进 Mojo 事件循环，
# 这样收 datagram 与处理 WS 在同一个 reactor 里完成。
sub setup_listeners {
    my ($self) = @_;

    my $reactor = Mojo::IOLoop->singleton->reactor;

    # Windows 的 perl 没有 AF_UNIX 支持（bind 报 WSAEAFNOSUPPORT，
    # 即「请求的协议还没有在系统中配置」），跳过 Unix listener，
    # 只保留 UDP。传 --socket '' 也可在任何平台显式禁用。
    my $path = $self->socket_path;
    if ($^O ne 'MSWin32' && defined $path && $path =~ /\S/) {
        unlink $path if -e $path;

        my $unix = IO::Socket::UNIX->new(
            Local    => $path,
            Type     => SOCK_DGRAM,
            Blocking => 0,
        ) or die "bind unix socket $path: $!\n";

        # Mojo::Reactor::Poll 的 io 回调只传一个参数（reactor 自身），
        # 所以这里不用签名式的 sub ($reactor, $writable)。
        $reactor->io($unix => sub { $self->handle_datagram($unix) });
        # io() 默认同时监听读和写。datagram socket 的发送缓冲区几乎总是
        # 不满，写事件因此永久就绪，EV 每秒会把回调调用十万次（实测约
        # 14 万次/秒），CPU 锁死在 100%。这里只保留读监听。
        $reactor->watch($unix, 1, 0);

        $self->{unix_socket} = $unix;
    }

    my $udp = IO::Socket::INET->new(
        LocalAddr => $self->udp_addr,
        LocalPort => $self->udp_port,
        Proto     => 'udp',
        Blocking  => 0,
        ReuseAddr => 1,
    ) or die "bind udp $self->{udp_addr}:$self->{udp_port}: $!\n";
    $reactor->io($udp => sub { $self->handle_datagram($udp) });
    $reactor->watch($udp, 1, 0);

    $self->{udp_socket} = $udp;

    return $self;
}

# socket 可读时把缓冲区里的 datagram 全部收干
sub handle_datagram {
    my ($self, $sock) = @_;

    while (1) {
        my $peer = recv($sock, my $buf, MAX_DGRAM, 0);
        return unless defined $peer;
        next unless defined $buf && $buf =~ /\S/;
        $self->handle_message($buf);
    }
}

# 收到的每条消息都广播，不做任何会话选择——
# 「哪些会话显示出来」完全由显示端（ESP32-S3）自己决定。
sub handle_message {
    my ($self, $raw) = @_;

    my $msg = eval { JSON::XS->new->utf8->decode($raw) };
    unless ($msg && ref($msg) eq 'HASH' && defined $msg->{state}) {
        warn "invalid message ignored: $@\n";
        return;
    }

    # 协议版本号：state=单会话事件，snapshot=全量快照。
    # 旧显示端只认 state 字段，新字段对它是透明无感的。
    $msg->{type} //= 'state';

    # 手动 --mode send 没带 session_id，补固定 id，让显示端给它留一个槽位。
    my $session_id = $msg->{session_id};
    unless (defined $session_id && length $session_id) {
        $session_id = MANUAL_SESSION_ID;
        $msg->{session_id} = $session_id;
    }

    my $sessions = $self->session_table;
    my $state    = $msg->{state} // '';
    my $cur      = $sessions->{$session_id};

    # off 表示会话结束（SessionEnd）：移出会话表，显示端据此删图标。
    # off 必须无条件广播并记账，否则会话结束清不掉图标。
    if ($state eq 'off') {
        delete $sessions->{$session_id};
    }
    elsif (defined $cur) {
        # 不降级守卫：SessionStart（→ ready）同一会话会发多次
        # （startup / resume / clear / compact / fork），而 resume 前不
        # 一定有 SessionEnd——会话可能正在干活。ready 不能把一个活着的
        # 会话打回隐形：只更新 last_msg，不广播，显示端不受打扰。
        # （这里无法用 Claude.pm 的 infer_state：它无状态，看不到会话表。）
        if ($state eq 'ready' && $cur->{state} ne 'ready') {
            $cur->{last_msg} = $msg;
            $self->last_message($msg);
            return $session_id;
        }
        $sessions->{$session_id} = {
            state    => $state,
            ts       => $msg->{ts} // int(Time::HiRes::time() * 1000),
            last_msg => $msg,
        };
    }
    else {
        # 新会话：已达上限就丢弃（不存表、不广播）。
        # 已有会话的更新不受这条限制，否则正在干活的会话会被新来的挤掉。
        # max_sessions 为 0 表示不限（--max-sessions 0）。
        my $cap = $self->max_sessions;
        if ($cap > 0 && scalar(keys %$sessions) >= $cap) {
            warn "session table full ($cap), new session $session_id dropped\n";
            return undef;
        }
        $sessions->{$session_id} = {
            state    => $state,
            ts       => $msg->{ts} // int(Time::HiRes::time() * 1000),
            last_msg => $msg,
        };
    }

    $self->last_message($msg);
    $self->broadcast($msg);

    return $session_id;
}

# 全量快照：WS 建连 / 重连时推一次，显示端据此重建全部图标。
# 无会话时返回 undef（不推），避免显示端收到空快照误清屏。
sub build_snapshot {
    my ($self) = @_;

    my $sessions = $self->session_table;
    return undef unless keys %$sessions;

    my @rows = map {
        my $msg = $sessions->{$_}{last_msg};
        my %row = (
            session_id => $_,
            state      => $sessions->{$_}{state},
            ts         => $sessions->{$_}{ts},
        );
        # 显示端按编辑器画不同的角标。没有 editor 时整键省略，而不是发
        # "editor":null：固件的 JSON 扫描器见到 null 会继续找下一个引号，
        # 把后面的键值误当成 editor 的值。
        $row{editor} = $msg->{editor}
            if defined $msg && defined $msg->{editor} && length $msg->{editor};
        +\%row;
    } keys %$sessions;

    return { type => 'snapshot', sessions => \@rows };
}

sub broadcast {
    my ($self, $msg) = @_;

    my $json = JSON::XS->new->utf8->canonical->encode($msg);

    for my $id (keys %{$self->subscribers}) {
        my $tx = $self->subscribers->{$id};
        next unless $tx;

        if ($tx->is_finished) {
            delete $self->subscribers->{$id};
            next;
        }

        eval { $tx->send($json); 1 }
            or delete $self->subscribers->{$id};
    }
}

sub run {
    my ($class, @argv) = @_;

    # 预扫描 --config（--config=X 或 --config X）：配置文件的值要先于
    # 其它选项的默认值加载（命令行显式参数仍最高优先）。
    # 不能用 Getopt::Long 做第一遍：它遇到未知的选项（--udp-port 等）
    # 会直接报错退出，而这里只想提前拿走 --config，其余留给下面的
    # 完整解析。注意因此 --config 不支持缩写，必须写全。
    my $config_path;
    for (my $i = 0; $i < @argv; $i++) {
        if ($argv[$i] =~ /\A--config=(.+)\z/) {
            $config_path = $1;
        }
        elsif ($argv[$i] eq '--config' && $i + 1 < @argv) {
            $config_path = $argv[ ++$i ];
        }
    }

    # 配置坏了直接死：服务端是长驻进程，带错误配置静默起在
    # 默认端口上，比启动失败更难排查。
    my $scfg = Playcat::AI::Sprites::Config->load_section($config_path, 'server');

    my %opt = (
        socket         => $scfg->{socket} // DEFAULT_SOCKET,
        'udp-addr'     => $scfg->{udp_addr} // DEFAULT_UDP_ADDR,
        'udp-port'     => $scfg->{udp_port} // DEFAULT_UDP_PORT,
        host           => $scfg->{host} // DEFAULT_HTTP_HOST,
        port           => $scfg->{port} // DEFAULT_HTTP_PORT,
        'max-sessions' => $scfg->{max_sessions} // DEFAULT_MAX_SESSIONS,
        help           => 0,
    );

    GetOptionsFromArray(
        \@argv,
        'config=s'       => \$config_path,
        'socket=s'       => \$opt{socket},
        'udp-addr=s'     => \$opt{'udp-addr'},
        'udp-port=i'     => \$opt{'udp-port'},
        'host=s'         => \$opt{host},
        'port=i'         => \$opt{port},
        'max-sessions=i' => \$opt{'max-sessions'},
        'help'           => \$opt{help},
    ) or $class->_usage(*STDERR, 2);

    $class->_usage(*STDOUT, 0) if $opt{help};

    # 负数没有意义（不是「更少的限制」，只是写错了），拦在启动时。
    die "invalid --max-sessions $opt{'max-sessions'} (must be 0 or positive)\n"
        if $opt{'max-sessions'} < 0;

    my $app = $class->new;
    $app->socket_path($opt{socket});
    $app->udp_addr($opt{'udp-addr'});
    $app->udp_port($opt{'udp-port'});
    $app->max_sessions($opt{'max-sessions'});
    $app->setup_listeners;

    # 关闭时清理 socket 文件，避免下次启动残留
    my $path = $opt{socket};
    local $SIG{INT} = local $SIG{TERM} = sub {
        unlink $path if defined $path && -e $path;
        exit 0;
    };

    # 用 Mojo::Server::Daemon 托管 HTTP/WS，它会自己跑事件循环；
    # datagram 的 reactor io 回调在同一个循环里被调度。
    require Mojo::Server::Daemon;
    my $daemon = Mojo::Server::Daemon->new(
        app    => $app,
        listen => ["http://$opt{host}:$opt{port}"],
        silent => 0,
    );
    # Daemon 的 inactivity_timeout 默认 30 秒：WS 订阅端（ESP32、ws_client.pl）
    # 在没有状态事件的空档会被当成死 HTTP 连接掐断，客户端只看到 1006
    # （TCP 断了无 close 帧），然后触发整轮断线重连。订阅连接应当长保活，
    # 这里关掉空闲超时；真正的死连接检测交给客户端的 ping。
    $daemon->inactivity_timeout(0);
    $daemon->run;
    return 0;
}

sub _usage {
    my ($class, $fh, $exit_code) = @_;

    my $socket   = DEFAULT_SOCKET;
    my $udp_addr = DEFAULT_UDP_ADDR;
    my $udp_port = DEFAULT_UDP_PORT;
    my $host     = DEFAULT_HTTP_HOST;
    my $port     = DEFAULT_HTTP_PORT;
    my $max_sessions = DEFAULT_MAX_SESSIONS;

    print {$fh} <<"USAGE";
Usage: server.pl [options]

Collect editor states via datagrams and fan them out over WebSocket.

Listeners:
  Unix datagram socket  $socket (option --socket; skipped on Windows / empty to disable)
  UDP                   $udp_addr:$udp_port (options --udp-addr / --udp-port)
  HTTP + WebSocket      http://$host:$port (options --host / --port)

Endpoints:
  GET  /        health page (client count, last state)
  GET  /state   last state as JSON
  WS   /ws      subscribe to state updates

Options:
  --config PATH         Config file (JSON, section "server"; see aisprites.json.example)
  --socket PATH       Unix datagram socket path
  --udp-addr ADDR     UDP bind address
  --udp-port PORT     UDP bind port
  --host HOST         HTTP/WS bind address
  --port PORT         HTTP/WS bind port
  --max-sessions N    session table cap (default $max_sessions, 0 = unlimited)
  --help              Show this help

Config: options may be set in a JSON config file (keys mirror option names,
dashes as underscores). Search order: --config, \$ENV{PLAYCAT_AI_SPRITES_CONFIG},
aisprites.json next to server.pl, ~/.playcat-ai-sprites/config.json.
Precedence: CLI flags > config file > defaults.
USAGE

    exit $exit_code;
}

1;
