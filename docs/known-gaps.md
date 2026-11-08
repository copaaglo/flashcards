# Known gaps

Things I know are missing, and what I'd do about them:

- **Monitoring and KEDA are kind only.** Staging and prod would need the stack on a 4 GB VM, or one central monitoring stack every cluster ships to.
- **Alerts go nowhere.** Alertmanager has no receiver yet. Next: a Slack webhook, routed by severity.
- **Chart changes skip staging.** Image tags go through promotion, but both environments render the chart from `main`, so a template change reaches prod right away. Details in [how a deploy works](how-a-deploy-works.md#known-gaps-in-this-process).
- **One VM per environment is a single point of failure.** Fine for a demo, not for real users. Next step up is a multi-node k3s cluster or EKS.
- **Schema is created on startup.** Real teams use migrations (Alembic) run as a pre-sync Job.
- **Local Postgres is 16, RDS is 17.** Small dev/prod drift that should be one version.
- **PDFs only, and only PDFs with a text layer.** Slides, audio, and OCR for image-only slides come next.
- **Evals use keyword overlap for grounding.** LLM-as-judge would catch wrong-but-plausible answers.
- **No tracing.** Metrics and logs, but no request traces across api, queue and worker.

