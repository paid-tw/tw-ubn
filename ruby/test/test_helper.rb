# frozen_string_literal: true

$LOAD_PATH.unshift File.expand_path('../lib', __dir__)

require 'json'
require 'minitest/autorun'
require 'paid_tw/ubn'

module Fixtures
  ROOT = File.expand_path('../..', __dir__)

  def self.json(name)
    JSON.parse(File.read(File.join(ROOT, 'fixtures', name)))
  end

  def self.sample_bans
    File.readlines(File.join(ROOT, 'crates/ubn-core/tests/fixtures/sample_bans.txt'), chomp: true)
        .map(&:strip)
        .select { |line| line.length == 8 }
  end
end
