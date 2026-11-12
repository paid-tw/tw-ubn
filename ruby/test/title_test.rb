# frozen_string_literal: true

require 'test_helper'

class TitleTest < Minitest::Test
  VECTORS = Fixtures.json('title-vectors.json')

  def test_flags_private_use_characters
    VECTORS.fetch('privateUse').each do |label, title|
      assert PaidTw::Ubn.private_use?(title), label
    end
  end

  def test_does_not_flag_other_characters
    VECTORS.fetch('notPrivateUse').each do |label, title|
      refute PaidTw::Ubn.private_use?(title), label
    end
  end

  def test_same_title
    VECTORS.fetch('same').each do |label, a, b|
      assert PaidTw::Ubn.same_title?(a, b), label
      assert PaidTw::Ubn.same_title?(b, a), "#{label} (reversed)"
    end
  end

  def test_different_title
    VECTORS.fetch('different').each do |label, a, b|
      refute PaidTw::Ubn.same_title?(a, b), label
      refute PaidTw::Ubn.same_title?(b, a), "#{label} (reversed)"
    end
  end

  def test_nil_matches_nothing
    refute PaidTw::Ubn.same_title?(nil, nil)
    refute PaidTw::Ubn.same_title?('ABC', nil)
  end

  def test_bytes_that_are_not_utf8_do_not_raise
    ["ABC\xFF".b, "ABC\xFF"].each do |broken|
      refute PaidTw::Ubn.same_title?(broken, 'ABC'), broken.encoding.name
      refute PaidTw::Ubn.private_use?(broken), broken.encoding.name
    end
  end
end
