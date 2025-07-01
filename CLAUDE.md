# Claude Instructions

## Code Formatting

Before making any commits or code changes, always run the Biome formatter to ensure consistent code style:

```bash
npm run format
```

This project uses Biome for code formatting and linting. The following scripts are available:

- `npm run format` - Format all files and write changes
- `npm run format-check` - Check formatting without making changes
- `npm run lint` - Run linting checks
- `npm run check` - Run both formatting and linting checks

**Important**: Always run `npm run format` before committing any code changes to maintain consistent formatting across the codebase.