# Podium Fetch

This repo has 3 parts:

1. `index.html` and `games.json` are for the frontend website, **do not upload any other files to the frontend!**
1. `scrape.mjs` generates the `games.json` file. `package.json` comes with `scrape.mjs`
1. `saturate.py` is only for PoCs to get emails of participants along with their names in the `saturated.json` file

To run:

First read the comments inside `scrape.mjs`

```bash
npm install
```

```bash
node scrape.mjs 
```

To saturate:

First make sure `games.json` exists already, then read the comments inside `saturate.py`

```bash
python saturate.py 
```
To deploy:

Copy the `index.html` and `games.json` into a new folder or repo so that they're the only files inside. Then deploy it statically over any platform. It is optional but recommended to delete the `id` and `votes` field from `games.json` before publishing.
