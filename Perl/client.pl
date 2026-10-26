#!/usr/bin/env perl
use v5.40;
use warnings;
use utf8;

use FindBin;
use lib "$FindBin::Bin/lib";

use Playcat::AI::Sprites::Client;

exit(Playcat::AI::Sprites::Client->run(@ARGV));
