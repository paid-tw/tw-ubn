# paid_tw-ubn

The Ruby counterpart of the [`@paid-tw/ubn`](https://www.npmjs.com/package/@paid-tw/ubn)
npm client, for the server side of a checkout: validate a Taiwan Unified
Business Number (統一編號), compare an invoice title (抬頭) with the registered
name, and look the registered name up through a deployed
[tw-ubn](https://github.com/paid-tw/tw-ubn) Worker.

Pure Ruby, no runtime dependencies, Ruby 3.2 or later.

```ruby
# Gemfile
gem 'paid_tw-ubn'
```

```ruby
require 'paid_tw/ubn'

PaidTw::Ubn.valid?('22099131')   # => true (post-2023 rule: sum divisible by 5)

title = PaidTw::Ubn.lookup_title('22099131', base_url: 'https://ubn.example.com', timeout: 2)

if title.nil?
  # No answer: bad checksum, timeout, network error, non-2xx, or a name that
  # cannot be used as a title. Treat the UBN as not looked up.
elsif !title.found?
  # No public source has this UBN. Not proof that it is invalid.
else
  title.name                      # => "台灣積體電路製造股份有限公司"
  title.status                    # => "active", "suspended", "closed" or nil (unknown)
  PaidTw::Ubn.same_title?(typed_title, title.name)
end
```

| Ruby | npm client |
|---|---|
| `PaidTw::Ubn.valid?(ban)` | `validateUBN(ban)` |
| `PaidTw::Ubn.lookup_title(ban, base_url:, timeout:)` | `lookupTitle(ban, { baseUrl, timeoutMs })` |
| `PaidTw::Ubn.same_title?(a, b)` | `isSameTitle(a, b)` |
| `PaidTw::Ubn.private_use?(title)` | `hasPrivateUse(title)` |

`lookup_title` never raises. `timeout` is in seconds and bounds the connection
and each read, not the whole call; the request is not retried. A found `Title`
also carries `ban`, `address`, `use_invoice`, `kind`, `source`,
`company_status`, `closed_date` and `setup_date`, each nil when the Worker did
not send it. What a lookup result means, and why "not found" is not "invalid",
is in the [repository README](https://github.com/paid-tw/tw-ubn#readme).

`same_title?` ignores full- vs half-width forms (NFKC), 臺 vs 台, whitespace and
Latin case. It never strips or abbreviates a legal form such as 股份有限公司.

The shard reader (`lookupVAT`, `shardOf`) and the direct FIA / GCIS clients of
the npm package are not ported: a server should ask the Worker, which caches.

## Develop

```bash
cd ruby && bundle install && bundle exec rake test
```

The tests read the vectors in [`../fixtures`](../fixtures), which the npm
client's tests read too, and the Rust core's sample of real UBNs.
