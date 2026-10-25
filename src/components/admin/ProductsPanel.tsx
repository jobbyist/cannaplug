import { useEffect, useRef, useState } from "react";
import { ImagePlus, PlusCircle, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { rand } from "@/lib/cart";
import {
  attachProductImageFn,
  createProductImageUploadFn,
  deactivateAdminProductFn,
  listAdminProductsFn,
  removeProductImageFn,
  saveAdminProductFn,
} from "@/lib/admin.functions";
import type { AdminProductInput } from "@/lib/admin-data.server";
import { CatalogueImport } from "@/components/admin/CatalogueImport";
import { ProductCsv } from "@/components/admin/ProductCsv";
import {
  PRODUCT_IMAGE_ACCEPT,
  PRODUCT_IMAGE_BUCKET,
  checkProductImageFile,
  fitWithin,
} from "@/lib/product-media";

type AdminProduct = Awaited<ReturnType<typeof listAdminProductsFn>>[number];

const blank: AdminProductInput = {
  slug: "",
  name: "",
  category: "Flower",
  subcategory: null,
  description: null,
  price_rand: 0,
  unit: null,
  strain_type: null,
  badge: null,
  sort_order: 100,
  low_stock_threshold: 5,
  is_active: true,
  sku: null,
  barcode: null,
  cost_rand: null,
  brand: null,
  sell_online: true,
  sold_by_weight: false,
  weight_step_g: 1,
  sale_price_rand: null,
  sale_ends_at: null,
  is_featured: false,
};

const TEXT_FIELDS: { key: keyof AdminProductInput; label: string; hint?: string }[] = [
  { key: "name", label: "Name" },
  { key: "slug", label: "Slug", hint: "Used in the web address, e.g. white-runtz-top-shelf" },
  { key: "category", label: "Category" },
  { key: "subcategory", label: "Subcategory" },
  { key: "brand", label: "Brand" },
  { key: "sku", label: "SKU", hint: "Unique. Matches the Yoco export for imports" },
  { key: "barcode", label: "Barcode" },
  { key: "unit", label: "Unit", hint: "e.g. g, pack, 300ml" },
  { key: "strain_type", label: "Strain type" },
  { key: "badge", label: "Badge" },
];

/** Downscales to at most 1200 px and re-encodes as WebP so photos stay small; falls back to the original. */
async function prepareImage(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.85));
    return blob && blob.size > 0 ? new File([blob], "photo.webp", { type: "image/webp" }) : file;
  } catch {
    return file;
  }
}

function toForm(p: AdminProduct | undefined): AdminProductInput {
  if (!p) return blank;
  return {
    slug: p.slug,
    name: p.name,
    category: p.category,
    subcategory: p.subcategory,
    description: p.description,
    // While on sale, price_rand is the sale price and regular_price_rand the normal one.
    price_rand: Number(p.regular_price_rand ?? p.price_rand),
    sale_price_rand: p.regular_price_rand != null ? Number(p.price_rand) : null,
    sale_ends_at: p.sale_ends_at,
    unit: p.unit,
    strain_type: p.strain_type,
    badge: p.badge,
    sort_order: p.sort_order,
    low_stock_threshold: p.low_stock_threshold ?? 5,
    is_active: p.is_active,
    sku: p.sku,
    barcode: p.barcode,
    cost_rand: p.cost_rand == null ? null : Number(p.cost_rand),
    brand: p.brand,
    sell_online: p.sell_online,
    sold_by_weight: p.sold_by_weight,
    weight_step_g: Number(p.weight_step_g) === 0.5 ? 0.5 : 1,
    is_featured: p.is_featured,
  };
}

export function ProductsPanel({
  products,
  editingProduct,
  setEditingProduct,
  onSaved,
  canEdit = true,
}: {
  products: AdminProduct[];
  editingProduct: string | null;
  setEditingProduct: (id: string | null) => void;
  onSaved: () => Promise<void>;
  /** Budtenders see the list only; every change is also refused on the server. */
  canEdit?: boolean;
}) {
  const product = products.find((p) => p.id === editingProduct);
  const [form, setForm] = useState<AdminProductInput>(blank);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setForm(toForm(product));
    setMessage(null);
    // Reset the form only when a different product is selected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id]);

  const set = (key: keyof AdminProductInput, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value === "" ? null : value }));

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await saveAdminProductFn({
        data: {
          productId: editingProduct === "new" ? undefined : (editingProduct ?? undefined),
          input: {
            ...form,
            name: form.name ?? "",
            slug: form.slug ?? "",
            category: form.category ?? "",
          },
        },
      });
      setEditingProduct(null);
      await onSaved();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not save the product.");
    } finally {
      setBusy(false);
    }
  };

  const uploadPhoto = async (picked: File) => {
    if (!product) return;
    setBusy(true);
    setMessage(null);
    try {
      const file = await prepareImage(picked);
      const problem = checkProductImageFile(file);
      if (problem) throw new Error(problem);
      const { path, token } = await createProductImageUploadFn({
        data: {
          productId: product.id,
          mime: file.type as "image/jpeg" | "image/png" | "image/webp",
        },
      });
      const { error } = await supabase.storage
        .from(PRODUCT_IMAGE_BUCKET)
        .uploadToSignedUrl(path, token, file, { contentType: file.type });
      if (error) throw new Error("The upload failed. Please try again.");
      await attachProductImageFn({ data: { productId: product.id, path } });
      await onSaved();
      setMessage("Photo saved.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not upload the photo.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="font-display text-xl font-extrabold uppercase">Products</h1>
          <p className="text-xs text-muted-foreground">
            Managers and admins edit products. Prices keep their history; cost prices are visible to
            managers only.
          </p>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <ProductCsv onSaved={onSaved} />
            <CatalogueImport onImported={onSaved} />
            <Button size="sm" onClick={() => setEditingProduct("new")}>
              <PlusCircle size={14} /> Add product
            </Button>
          </div>
        )}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-14">Photo</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>SKU</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Price</TableHead>
            <TableHead>Status</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {products.map((p) => (
            <TableRow key={p.id}>
              <TableCell>
                {p.image_url ? (
                  <img
                    src={p.image_url}
                    alt={p.name}
                    width={40}
                    height={40}
                    className="h-10 w-10 rounded object-cover"
                  />
                ) : (
                  <span className="grid h-10 w-10 place-items-center rounded bg-secondary text-[0.6rem] text-muted-foreground">
                    None
                  </span>
                )}
              </TableCell>
              <TableCell>{p.name}</TableCell>
              <TableCell className="font-mono text-xs">{p.sku ?? "—"}</TableCell>
              <TableCell>{p.category}</TableCell>
              <TableCell>
                {p.regular_price_rand != null ? (
                  <span>
                    <s className="mr-1 text-muted-foreground">
                      {rand(Number(p.regular_price_rand))}
                    </s>
                    <b>{rand(Number(p.price_rand))}</b> <Badge variant="outline">Sale</Badge>
                  </span>
                ) : (
                  rand(Number(p.price_rand))
                )}
                {p.sold_by_weight && <span className="text-muted-foreground"> / g</span>}
              </TableCell>
              <TableCell>
                <Badge variant={p.is_active ? "default" : "secondary"}>
                  {p.is_active ? "Active" : "Inactive"}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                {canEdit && (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setEditingProduct(p.id)}>
                      Edit
                    </Button>
                    {p.is_active && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void deactivateAdminProductFn({ data: { productId: p.id } }).then(onSaved)
                        }
                      >
                        Deactivate
                      </Button>
                    )}
                  </>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {canEdit && editingProduct && (
        <div
          className="mt-6 rounded-xl border border-border bg-card p-5"
          data-testid="product-editor"
        >
          <h2 className="mb-4 font-display text-sm font-bold uppercase">
            {editingProduct === "new" ? "Add product" : `Edit ${product?.name ?? "product"}`}
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {TEXT_FIELDS.map(({ key, label, hint }) => (
              <div key={key} className="space-y-1">
                <Label htmlFor={`product-${key}`}>{label}</Label>
                <Input
                  id={`product-${key}`}
                  value={(form[key] as string | null) ?? ""}
                  onChange={(e) => set(key, e.target.value)}
                />
                {hint && <p className="text-[0.65rem] text-muted-foreground">{hint}</p>}
              </div>
            ))}
            <div className="space-y-1">
              <Label htmlFor="product-price">
                {form.sold_by_weight ? "Regular price per gram (R)" : "Regular price (R)"}
              </Label>
              <Input
                id="product-price"
                type="number"
                min={0}
                step="0.01"
                value={form.price_rand}
                onChange={(e) => setForm((f) => ({ ...f, price_rand: Number(e.target.value) }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="product-sale">Sale price (R, optional)</Label>
              <Input
                id="product-sale"
                type="number"
                min={0}
                step="0.01"
                value={form.sale_price_rand ?? ""}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    sale_price_rand: e.target.value === "" ? null : Number(e.target.value),
                  }))
                }
              />
              <p className="text-[0.65rem] text-muted-foreground">
                Lower than the regular price. Leave empty to end the sale.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="product-sale-ends">Sale ends (optional)</Label>
              <Input
                id="product-sale-ends"
                type="datetime-local"
                value={form.sale_ends_at ? form.sale_ends_at.slice(0, 16) : ""}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    sale_ends_at: e.target.value ? new Date(e.target.value).toISOString() : null,
                  }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="product-cost">Cost price (R, managers only)</Label>
              <Input
                id="product-cost"
                type="number"
                min={0}
                step="0.01"
                value={form.cost_rand ?? ""}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    cost_rand: e.target.value === "" ? null : Number(e.target.value),
                  }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="product-sort">Sort order</Label>
              <Input
                id="product-sort"
                type="number"
                min={0}
                value={form.sort_order}
                onChange={(e) => setForm((f) => ({ ...f, sort_order: Number(e.target.value) }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="product-low-stock">Low-stock alert at</Label>
              <Input
                id="product-low-stock"
                type="number"
                min={0}
                max={100000}
                value={form.low_stock_threshold ?? 5}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    low_stock_threshold: Math.max(0, Math.floor(Number(e.target.value) || 0)),
                  }))
                }
              />
              <p className="text-[0.7rem] text-muted-foreground">
                Managers are emailed when available stock falls to this number (0 = never).
              </p>
            </div>
            <div className="space-y-2 rounded-md border border-border p-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={Boolean(form.sold_by_weight)}
                  onChange={(e) => setForm((f) => ({ ...f, sold_by_weight: e.target.checked }))}
                />
                Sold by weight (priced per gram)
              </label>
              {form.sold_by_weight && (
                <div className="space-y-1">
                  <Label htmlFor="product-step">Smallest step at the till</Label>
                  <select
                    id="product-step"
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={String(form.weight_step_g ?? 1)}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, weight_step_g: e.target.value === "0.5" ? 0.5 : 1 }))
                    }
                  >
                    <option value="1">1 g</option>
                    <option value="0.5">0.5 g</option>
                  </select>
                  <p className="text-[0.65rem] text-muted-foreground">
                    The till sells whole grams today; 0.5 g steps switch on with the
                    fractional-weight update.
                  </p>
                </div>
              )}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.sell_online !== false}
                  onChange={(e) => setForm((f) => ({ ...f, sell_online: e.target.checked }))}
                />
                Sold online (untick for in-store-only items such as Lounge sessions)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={Boolean(form.is_featured)}
                  onChange={(e) => setForm((f) => ({ ...f, is_featured: e.target.checked }))}
                />
                Featured on the homepage (up to 8 are shown)
              </label>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="product-description">Description</Label>
              <textarea
                id="product-description"
                className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={form.description ?? ""}
                onChange={(e) => set("description", e.target.value)}
              />
            </div>
          </div>

          <div className="mt-5 rounded-lg border border-dashed border-border p-4">
            <Label>Photo</Label>
            {editingProduct === "new" ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Save the product first, then add a photo.
              </p>
            ) : (
              <div className="mt-2 flex items-center gap-4">
                {product?.image_url ? (
                  <img
                    src={product.image_url}
                    alt={product.name}
                    width={96}
                    height={96}
                    className="h-24 w-24 rounded-lg object-cover"
                  />
                ) : (
                  <div className="grid h-24 w-24 place-items-center rounded-lg bg-secondary text-xs text-muted-foreground">
                    No photo
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept={PRODUCT_IMAGE_ACCEPT}
                    className="hidden"
                    aria-label="Product photo"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadPhoto(f);
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => fileRef.current?.click()}
                  >
                    <ImagePlus size={14} /> {product?.image_url ? "Replace photo" : "Add photo"}
                  </Button>
                  {product?.image_url && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void removeProductImageFn({ data: { productId: product.id } }).then(onSaved)
                      }
                    >
                      <Trash2 size={14} /> Remove
                    </Button>
                  )}
                  <p className="text-[0.65rem] text-muted-foreground">
                    JPG, PNG or WebP. Resized to 1200 px.
                  </p>
                </div>
              </div>
            )}
          </div>

          {message && (
            <p role="status" className="mt-3 text-sm">
              {message}
            </p>
          )}
          <div className="mt-4 flex gap-2">
            <Button disabled={busy} onClick={() => void save()}>
              Save
            </Button>
            <Button variant="outline" onClick={() => setEditingProduct(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
