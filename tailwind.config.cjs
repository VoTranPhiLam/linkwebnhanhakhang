/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx,scss}"],
  theme: {
    extend: {
      colors: {
        bid: "#29b6f6",
        ask: "#ef5350",
      },
    },
  },
  plugins: [],
};
