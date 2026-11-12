# frozen_string_literal: true

require 'test_helper'

class ChecksumTest < Minitest::Test
  def test_accepts_real_ubns
    %w[22099131 87006234 87006591 47529263 38965019].each do |ban|
      assert PaidTw::Ubn.valid?(ban), ban
    end
  end

  def test_rejects_wrong_length_and_non_digits
    ['1234567', '123456789', '2209913X', '', ' 22099131', "22099131\n", '２２０９９１３１'].each do |ban|
      refute PaidTw::Ubn.valid?(ban), ban.inspect
    end
  end

  def test_rejects_a_broken_check_digit
    refute PaidTw::Ubn.valid?('22099130')
  end

  def test_rejects_values_that_are_not_strings
    [nil, 22_099_131, :'22099131', ['22099131']].each do |ban|
      refute PaidTw::Ubn.valid?(ban), ban.inspect
    end
  end

  # 10458574 sums to 29: valid only because its seventh digit is 7, which may
  # count one more. 10458504 sums to 19 with no such allowance.
  def test_seventh_digit_seven_may_count_one_more
    assert PaidTw::Ubn.valid?('10458574')
    refute PaidTw::Ubn.valid?('10458576')
    refute PaidTw::Ubn.valid?('10458504')
  end

  def test_accepts_every_sampled_real_ubn_as_the_rust_core_does
    bans = Fixtures.sample_bans

    assert_operator bans.length, :>, 1000
    assert_empty(bans.reject { |ban| PaidTw::Ubn.valid?(ban) })
  end
end
