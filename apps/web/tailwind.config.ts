import type { Config } from "tailwindcss";

const v = (n: string) => `rgb(var(--${n}) / <alpha-value>)`;

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        chalk: v("chalk"), paper: v("paper"), ink: v("ink"), soft: v("soft"),
        mist: v("mist"), teal: v("teal"), amber: v("amber"), rust: v("rust"),
      },
      fontFamily: {
        serif: ["Charter", "'Bitstream Charter'", "'Iowan Old Style'", "Georgia", "serif"],
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "'Segoe UI'", "Roboto", "sans-serif"],
      },
      borderRadius: { board: "3px" },
    },
  },
  plugins: [],
} satisfies Config;
