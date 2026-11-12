# frozen_string_literal: true

require_relative 'lib/paid_tw/ubn/version'

Gem::Specification.new do |spec|
  spec.name = 'paid_tw-ubn'
  spec.version = PaidTw::Ubn::VERSION
  spec.authors = ['paid-tw']
  spec.summary = 'Taiwan business number (統一編號) checksum, invoice-title comparison and title lookup'
  spec.description = 'The Ruby counterpart of the @paid-tw/ubn npm client: validate a Taiwan Unified ' \
                     'Business Number, compare an invoice title with the registered name, and look the ' \
                     'registered name up through a deployed tw-ubn Worker.'
  spec.homepage = 'https://github.com/paid-tw/tw-ubn'
  spec.license = 'MIT'
  spec.required_ruby_version = '>= 3.2'

  spec.metadata = {
    'source_code_uri' => 'https://github.com/paid-tw/tw-ubn/tree/main/ruby',
    'changelog_uri' => 'https://github.com/paid-tw/tw-ubn/blob/main/CHANGELOG.md',
    'bug_tracker_uri' => 'https://github.com/paid-tw/tw-ubn/issues',
    'rubygems_mfa_required' => 'true'
  }

  spec.files = Dir['lib/**/*.rb'] + %w[README.md LICENSE]
  spec.require_paths = ['lib']
end
