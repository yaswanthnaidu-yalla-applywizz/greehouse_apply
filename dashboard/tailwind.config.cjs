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
        page: '#FFF5EB',
        coral: '#E88474',
        dark: '#1A1A2E',
        card: '#FFFFFF',
        'metric-yellow': '#F4D66B',
        'metric-yellow-text': '#5C4A0A',
        'metric-coral': '#E88474',
        'metric-coral-text': '#6B2C2C',
        'metric-green': '#9AC89A',
        'metric-green-text': '#1E4620',
        'metric-blue': '#B8D4E8',
        'metric-blue-text': '#1E3A5F',
        supabase: '#10B981',
        ai: '#8B5CF6',
        manual: '#F59E0B',
        unresolved: '#EF4444',
      },
    },
  },
  plugins: [],
};
