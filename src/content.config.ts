import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const projects = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/projects' }),
  schema: z.object({
    title: z.string(),
    url: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
    badges: z.array(z.object({
      text: z.string(),
      type: z.enum(['live', 'oss']),
      url: z.string().optional(),
    })),
    order: z.number().optional(),
  }),
});

export const collections = { projects };
