/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './dashboard/public/**/*.html',
    './dashboard/public/**/*.jsx',
    './dashboard/public/**/*.js',
    './dashboard/**/*.tsx',
    './dashboard/components/**/*.tsx',
  ],
  theme: {
    extend: {
      colors: {
        page: '#0a0a0a',
        surface1: '#1c1c1e',
        surface2: '#2c2c2e',
        surface3: '#3a3a3c',
        muted: '#8e8e93',
        coral: '#E88474',
        dark: '#1c1c1e',
        card: '#1c1c1e',
        'metric-yellow': '#ff9f0a',
        'metric-yellow-text': '#ff9f0a',
        'metric-coral': '#ff453a',
        'metric-coral-text': '#ff453a',
        'metric-green': '#30d158',
        'metric-green-text': '#30d158',
        'metric-blue': '#0a84ff',
        'metric-blue-text': '#0a84ff',
        supabase: '#0a84ff',
        ai: '#5ac8fa',
        manual: '#0071e3',
        unresolved: '#ff453a',
      },
    },
  },
  plugins: [],
};
