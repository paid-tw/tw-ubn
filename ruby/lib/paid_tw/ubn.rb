# frozen_string_literal: true

require 'json'
require 'net/http'
require 'uri'

require_relative 'ubn/version'

module PaidTw
  # Taiwan Unified Business Number (UBN/BAN) helpers: checksum
  # validation, invoice-title comparison, and a title lookup against a deployed
  # tw-ubn Worker. The Ruby counterpart of the `@paid-tw/ubn` npm client; the
  # two are held together by the vectors in `fixtures/`.
  module Ubn
    WEIGHTS = [1, 2, 1, 2, 1, 2, 4, 1].freeze

    # What ECMAScript's `\s` matches, so that a title compares the same here as
    # in the npm client. Ruby's own `\s` is ASCII-only and `[[:space:]]` differs
    # on U+0085 and U+FEFF.
    WHITESPACE = "\t\n\v\f\r    -     　﻿"
    WHITESPACE_RUN = /[#{WHITESPACE}]+/
    PRIVATE_USE = /\p{Co}/

    # A capital sigma that ends a word: a cased letter before it and none after
    # it, case-ignorable characters (combining marks, full stops, apostrophes,
    # ...) skipped on both sides. ECMAScript's `toLowerCase` gives it the final
    # form "ς"; Ruby's `downcase` knows no context and gives "σ". A character
    # that is both cased and case-ignorable counts as ignorable, as JavaScript
    # engines have it.
    CASED = '[\p{Cased}&&\P{Case_Ignorable}]'
    FINAL_SIGMA = /(#{CASED}\p{Case_Ignorable}*)Σ(?!\p{Case_Ignorable}*#{CASED})/

    STATUSES = %w[active suspended closed].freeze
    KINDS = %w[business nonprofit school agency].freeze
    SOURCES = %w[dataset fia-api gcis].freeze

    DEFAULT_TIMEOUT = 2

    # The answer of `lookup_title`. `found?` is false when the Worker answered
    # and no source it consulted has a record; every other field is then nil.
    # A nil `status` means unknown, not active.
    Title = Data.define(
      :found, :ban, :name, :status, :address, :use_invoice, :kind, :source,
      :company_status, :closed_date, :setup_date
    ) do
      def initialize(found:, ban: nil, name: nil, status: nil, address: nil, use_invoice: nil,
                     kind: nil, source: nil, company_status: nil, closed_date: nil, setup_date: nil)
        super
      end

      def found? = found
    end

    NOT_FOUND = Title.new(found: false)

    module_function

    # True when `ban` is a well-formed 8-digit UBN under the post-2023 rule
    # (weighted digit sum divisible by 5). It says nothing about whether the
    # number is registered. Never raises: a value that is not a string, or a
    # string whose bytes are invalid in its own encoding, is false.
    def valid?(ban)
      # A regexp raises on a string it cannot read: one with invalid bytes, or
      # in an encoding that is not ASCII-compatible (UTF-16, UTF-32).
      return false unless ban.is_a?(String) && ban.encoding.ascii_compatible? && ban.valid_encoding?
      return false unless ban.match?(/\A[0-9]{8}\z/)

      sum = ban.each_char.with_index.sum do |char, index|
        product = char.to_i * WEIGHTS[index]
        (product / 10) + (product % 10)
      end

      (sum % 5).zero? || (ban[6] == '7' && ((sum + 1) % 5).zero?)
    end

    # True when `title` contains a Unicode Private Use Area character. The tax
    # registry writes some names with locally-defined glyphs mapped there; they
    # render as boxes and an e-invoice platform rejects them.
    def private_use?(title)
      utf8(title).match?(PRIVATE_USE)
    end

    # True when two invoice titles name the same entity once incidental typing
    # differences are ignored: full- vs half-width forms (NFKC), the two
    # spellings of "tai" (U+81FA and U+53F0), all whitespace, and Latin case.
    # Legal forms are never stripped or abbreviated ("Co., Ltd." written in
    # full is not its bracketed short form), and an empty title matches nothing.
    # Neither does a title with bytes that have no reading as UTF-8: a string
    # in another encoding is compared by its characters, one that is broken or
    # binary with non-ASCII bytes is not compared at all.
    def same_title?(a, b)
      normalized = normalize_title(a)
      !normalized.empty? && normalized == normalize_title(b)
    end

    # Looks up the registered name of `ban` through a deployed tw-ubn Worker
    # (`GET <base_url>/v1/vat/<ban>`). Never raises. Three outcomes:
    #
    # - a `Title` with `found?` true: a registration with a usable name. Its
    #   `status` may be "suspended" or "closed"; what to do then is the
    #   caller's call.
    # - `NOT_FOUND`: the Worker answered and no source has a record. This is
    #   not proof of an invalid UBN: many withholding-unit UBNs (clinics,
    #   professional practices, ...) have no public record.
    # - nil: no answer. A malformed UBN (no request is made), a timeout, a
    #   network error, any non-2xx response, a body that is not the expected
    #   JSON, a `ban` in the body other than the one asked for, or a name that
    #   is empty or carries Private Use Area glyphs.
    #
    # `timeout` is in seconds and bounds the connection and each read, not the
    # whole call. `http` replaces the transport: a callable taking the URL and
    # the timeout, returning `[status, body]`.
    def lookup_title(ban, base_url:, timeout: DEFAULT_TIMEOUT, http: nil)
      return nil unless valid?(ban)

      url = "#{base_url.to_s.sub(%r{/+\z}, '')}/v1/vat/#{ban}"
      status, body = (http || method(:get)).call(url, timeout)
      return nil unless (200..299).cover?(status)

      parse(JSON.parse(body), ban)
    rescue StandardError
      nil
    end

    def get(url, timeout)
      uri = URI.parse(url)
      raise ArgumentError, "not an http(s) URL: #{url}" unless uri.is_a?(URI::HTTP)

      options = {
        use_ssl: uri.scheme == 'https',
        open_timeout: timeout,
        read_timeout: timeout,
        write_timeout: timeout,
        # Net::HTTP retries an idempotent request once, which would double the
        # time a dead Worker can hold the caller.
        max_retries: 0
      }
      response = Net::HTTP.start(uri.host, uri.port, **options) do |connection|
        connection.get(uri.request_uri)
      end
      [response.code.to_i, response.body]
    end

    def parse(body, ban)
      return nil unless body.is_a?(Hash)

      found = body['found']
      return nil unless [true, false].include?(found)
      return nil if body.key?('ban') && body['ban'] != ban
      return NOT_FOUND unless found

      name = body['name']
      return nil unless name.is_a?(String) && !name.gsub(WHITESPACE_RUN, '').empty?
      return nil if body['nameHasPrivateUse'] == true || private_use?(name)

      Title.new(
        found: true,
        ban: ban,
        name: name,
        status: one_of(body['status'], STATUSES),
        address: string(body['address']),
        use_invoice: [true, false].include?(body['useInvoice']) ? body['useInvoice'] : nil,
        kind: one_of(body['kind'], KINDS),
        source: one_of(body['source'], SOURCES),
        company_status: string(body['companyStatus']),
        closed_date: string(body['closedDate']),
        setup_date: string(body['setupDate'])
      )
    end

    # A title that has no reading as UTF-8 normalizes to the empty title, which
    # matches nothing. Replacing its unreadable bytes instead would turn each
    # into the same U+FFFD and make different titles compare equal.
    def normalize_title(title)
      text = title.to_s.encode(Encoding::UTF_8)
      return '' unless text.valid_encoding?

      text
        .unicode_normalize(:nfkc)
        .tr('臺', '台')
        .gsub(WHITESPACE_RUN, '')
        .then { |stripped| lowercase(stripped) }
    rescue EncodingError
      ''
    end

    # `String#downcase` as ECMAScript's `toLowerCase` has it: see FINAL_SIGMA.
    def lowercase(text)
      return text.downcase unless text.include?('Σ')

      text.gsub(FINAL_SIGMA, '\1ς').downcase
    end

    def utf8(value)
      value.to_s.encode(Encoding::UTF_8, invalid: :replace, undef: :replace)
    end

    def one_of(value, allowed)
      value if allowed.include?(value)
    end

    def string(value)
      value if value.is_a?(String)
    end

    private_class_method :get, :parse, :normalize_title, :lowercase, :utf8, :one_of, :string
  end
end
