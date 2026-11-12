# frozen_string_literal: true

require 'socket'
require 'test_helper'

class LookupTitleTest < Minitest::Test
  VECTORS = Fixtures.json('lookup-title-vectors.json')
  BAN = VECTORS.fetch('ban')
  BASE = 'https://ubn.example.test'

  WIRE_NAMES = {
    'found' => :found, 'ban' => :ban, 'name' => :name, 'status' => :status, 'address' => :address,
    'useInvoice' => :use_invoice, 'kind' => :kind, 'source' => :source,
    'companyStatus' => :company_status, 'closedDate' => :closed_date, 'setupDate' => :setup_date
  }.freeze

  def respond(status, body)
    ->(_url, _timeout) { [status, body] }
  end

  def test_shared_vectors
    VECTORS.fetch('cases').each do |vector|
      result = PaidTw::Ubn.lookup_title(BAN, base_url: BASE, http: respond(vector['status'], vector['body']))
      expected = vector['expect']

      if expected.nil?
        assert_nil result, vector['label']
      else
        assert_equal expected.transform_keys { |key| WIRE_NAMES.fetch(key) }, result.to_h.compact, vector['label']
      end
    end
  end

  def test_not_found_is_an_answer
    result = PaidTw::Ubn.lookup_title(BAN, base_url: BASE, http: respond(200, '{"found":false}'))

    assert_same PaidTw::Ubn::NOT_FOUND, result
    refute_predicate result, :found?
  end

  def test_found
    body = %({"found":true,"ban":"#{BAN}","name":"ABC","useInvoice":false})
    result = PaidTw::Ubn.lookup_title(BAN, base_url: BASE, http: respond(200, body))

    assert_predicate result, :found?
    assert_equal 'ABC', result.name
    assert_equal false, result.use_invoice
    assert_nil result.status
  end

  def test_builds_the_url_from_base_url
    {
      BASE => "#{BASE}/v1/vat/#{BAN}",
      "#{BASE}/" => "#{BASE}/v1/vat/#{BAN}",
      "#{BASE}//" => "#{BASE}/v1/vat/#{BAN}",
      "#{BASE}/ubn/" => "#{BASE}/ubn/v1/vat/#{BAN}"
    }.each do |base_url, expected|
      asked = nil
      http = lambda do |url, _timeout|
        asked = url
        [200, '{"found":false}']
      end
      PaidTw::Ubn.lookup_title(BAN, base_url: base_url, http: http)

      assert_equal expected, asked
    end
  end

  def test_passes_the_timeout_to_the_transport
    given = []
    http = lambda do |_url, timeout|
      given << timeout
      [200, '{"found":false}']
    end
    PaidTw::Ubn.lookup_title(BAN, base_url: BASE, http: http)
    PaidTw::Ubn.lookup_title(BAN, base_url: BASE, timeout: 0.3, http: http)

    assert_equal [2, 0.3], given
  end

  def test_makes_no_request_for_an_invalid_ubn
    ['22099130', '1234567', '2209913X', '', ' 22099131', nil].each do |ban|
      called = false
      http = lambda do |_url, _timeout|
        called = true
        [200, '{"found":true,"name":"x"}']
      end

      assert_nil PaidTw::Ubn.lookup_title(ban, base_url: BASE, http: http), ban.inspect
      refute called, ban.inspect
    end
  end

  def test_a_transport_error_is_no_answer
    [SocketError, Timeout::Error, Errno::ECONNREFUSED, OpenSSL::SSL::SSLError].each do |error|
      http = ->(_url, _timeout) { raise error }

      assert_nil PaidTw::Ubn.lookup_title(BAN, base_url: BASE, http: http), error.name
    end
  end

  def test_a_base_url_that_is_not_http_is_no_answer
    assert_nil PaidTw::Ubn.lookup_title(BAN, base_url: 'ftp://ubn.example.test')
    assert_nil PaidTw::Ubn.lookup_title(BAN, base_url: 'not a url')
    assert_nil PaidTw::Ubn.lookup_title(BAN, base_url: nil)
  end

  # The cases below run the built-in transport against a local socket.

  def serve(response: nil, close: true)
    server = TCPServer.new('127.0.0.1', 0)
    requests = []
    connections = []
    thread = Thread.new do
      loop do
        client = server.accept
        connections << client
        requests << client.gets
        if response
          client.write(response)
          client.close if close
        end
      end
    rescue IOError, Errno::EBADF
      nil
    end
    yield "http://127.0.0.1:#{server.addr[1]}", requests, connections
  ensure
    server&.close
    thread&.kill
  end

  def http_response(status, body)
    "HTTP/1.1 #{status} X\r\nContent-Type: application/json\r\n" \
      "Content-Length: #{body.bytesize}\r\nConnection: close\r\n\r\n#{body}"
  end

  def test_built_in_transport_reads_an_answer
    body = %({"found":true,"ban":"#{BAN}","name":"ABC","status":"active"})
    serve(response: http_response(200, body)) do |base_url, requests|
      result = PaidTw::Ubn.lookup_title(BAN, base_url: "#{base_url}/ubn/")

      assert_equal 'ABC', result.name
      assert_equal 'active', result.status
      assert_equal ["GET /ubn/v1/vat/#{BAN} HTTP/1.1\r\n"], requests
    end
  end

  def test_built_in_transport_treats_a_502_as_no_answer
    serve(response: http_response(502, '{"found":null,"error":"upstream_unavailable"}')) do |base_url, _requests|
      assert_nil PaidTw::Ubn.lookup_title(BAN, base_url: base_url)
    end
  end

  # The status is known once the headers are in. An error body that never
  # arrives must not hold the caller until the read timeout.
  def test_built_in_transport_does_not_wait_for_the_body_of_a_502
    headers = "HTTP/1.1 502 X\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n"
    serve(response: headers, close: false) do |base_url, _requests|
      started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      result = PaidTw::Ubn.lookup_title(BAN, base_url: base_url, timeout: 5)
      elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started

      assert_nil result
      assert_operator elapsed, :<, 2
    end
  end

  def test_built_in_transport_gives_up_on_a_silent_server_without_retrying
    serve do |base_url, requests|
      started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      result = PaidTw::Ubn.lookup_title(BAN, base_url: base_url, timeout: 0.2)
      elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started

      assert_nil result
      assert_operator elapsed, :<, 1.5
      assert_equal 1, requests.length
    end
  end

  def test_built_in_transport_does_not_connect_for_a_base_url_that_is_not_http
    serve(response: http_response(200, '{"found":false}')) do |base_url, _requests, connections|
      assert_nil PaidTw::Ubn.lookup_title(BAN, base_url: base_url.sub('http://', 'ftp://'))
      sleep 0.1
      assert_empty connections
    end
  end

  def test_built_in_transport_treats_a_refused_connection_as_no_answer
    server = TCPServer.new('127.0.0.1', 0)
    port = server.addr[1]
    server.close

    assert_nil PaidTw::Ubn.lookup_title(BAN, base_url: "http://127.0.0.1:#{port}")
  end
end
