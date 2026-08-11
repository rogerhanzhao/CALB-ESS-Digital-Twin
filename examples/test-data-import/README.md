# Test data import template · V0.2

This template is the first operator-facing intake contract for measured cell data. Copy
`configuration.template.yaml`, replace every placeholder, and use limits from the approved product
and test-plan records. Generic platform code contains no CALB product safety limits.

Calculate the immutable source checksum in PowerShell:

```powershell
(Get-FileHash .\measured.csv -Algorithm SHA256).Hash.ToLower()
```

Validate and create a new dataset-revision artifact directory:

```powershell
calb-validate-test-data .\measured.csv .\configuration.yaml .\revision-output
```

The command refuses to reuse an existing output directory. A passing or warning result produces
`canonical.csv` plus `validation-report.json`; a rejected import produces only the report and exits
with code `2`. For cycle-ageing data, a valid `cycle_metric_policy` also produces
`cycle-metrics.json` with measured charge/discharge capacity, energy, throughput, efficiency,
equivalent full cycles, and explicit partial-cycle status. The source file is never modified.
Warnings require reviewer disposition before the dataset revision can enter calibration.

The numeric values under `policy` in the template are deliberately invalid placeholders. Alex.Z
must accept the first real import mapping and its product/test-plan limits before operational use.
