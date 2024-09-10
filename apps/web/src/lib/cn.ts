import clsx, { type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['2xs', 'xs', 'sm', 'base', 'lg', 'xl', '2xl'] }] } },
});

/** Joins class names and lets later Tailwind utilities override earlier ones. */
export const cn = (...v: ClassValue[]) => twMerge(clsx(v));
