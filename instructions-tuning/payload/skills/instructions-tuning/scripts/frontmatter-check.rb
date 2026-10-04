#!/usr/bin/env ruby
# PostToolUse hook of the instructions-tuning skill (its frontmatter `hooks:`): after a Write or Edit of a SKILL.md or
# an agent definition, checks the frontmatter the way Claude Code will read it. A broken one fails silently — the
# skill never lists, the agent never routes — so the check runs on the edit instead of the agent remembering to.
# Exit 2 puts the problems in front of the model; the edit itself stands. Any other file: exit 0 at once.
#
# usage: hook stdin (PostToolUse JSON), or frontmatter-check.rb <file> for a manual run
require 'json'
require 'yaml'

path =
  if ARGV[0]
    ARGV[0]
  else
    begin
      JSON.parse($stdin.read).dig('tool_input', 'file_path')
    rescue StandardError
      nil
    end
  end
exit 0 unless path.is_a?(String)

kind =
  if File.basename(path) == 'SKILL.md' then :skill
  # agents/ inside a skill folder holds prompts the skill reads, not agent definitions
  elsif File.extname(path) == '.md' && File.basename(File.dirname(path)) == 'agents' &&
        !File.exist?(File.join(File.dirname(File.dirname(path)), 'SKILL.md')) then :agent
  end
exit 0 if kind.nil? || !File.file?(path)

text = File.read(path, encoding: 'UTF-8')
problems = []
m = text.match(/\A---\r?\n(.*?)\r?\n---\r?\n/m)
if m.nil?
  problems << 'no frontmatter: the file must open with a `---` block (nothing above it, not even a comment) and close it with `---`'
else
  # Claude Code reads an unquoted one-line value holding `: ` as a string, so that alone is no problem; a block that
  # fails even with every top-level one-line value quoted is broken for it too.
  lenient = m[1].gsub(/^([A-Za-z_-]+):[ \t]+(?!["'|>\[{])(.+)$/) { "#{$1}: #{$2.strip.to_json}" }
  begin
    fm = begin
      YAML.safe_load(m[1])
    rescue Psych::Exception
      YAML.safe_load(lenient)
    end
  rescue Psych::Exception => e
    fm = nil
    problems << "frontmatter is not valid YAML (#{e.message.lines.first.strip})"
  end
  if m && problems.empty?
    if !fm.is_a?(Hash)
      problems << 'frontmatter is not a key: value map'
    else
      name = fm['name']
      desc = fm['description']
      if desc.nil? || (desc.is_a?(String) && desc.strip.empty?)
        problems << 'no `description`: it is the only text that decides when this fires'
      elsif !desc.is_a?(String)
        problems << '`description` is not a string'
      elsif kind == :skill && desc.length > 1024
        problems << "`description` is #{desc.length} characters, the limit is 1024 — cut the summary, keep the trigger"
      end
      if kind == :agent && name.nil?
        problems << 'no `name`: an agent definition needs one'
      end
      if !name.nil?
        if !name.is_a?(String) || name !~ /\A[a-z0-9][a-z0-9-]{0,63}\z/
          problems << "`name` #{name.inspect} must be lowercase letters, digits and hyphens, at most 64"
        end
      end
    end
  end
end

exit 0 if problems.empty?
warn "#{path}: frontmatter problems:"
problems.each { |p| warn "- #{p}" }
exit 2
