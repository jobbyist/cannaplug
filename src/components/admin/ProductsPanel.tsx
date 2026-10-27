import { PlusCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { rand } from "@/lib/cart";
import { deactivateAdminProductFn, listAdminProductsFn } from "@/lib/admin.functions";
import { CatalogueImport } from "@/components/admin/CatalogueImport";
import { ProductEditDialog } from "@/components/admin/ProductEditDialog";
import { ProductCsv } from "@/components/admin/ProductCsv";

type AdminProduct = Awaited<ReturnType<typeof listAdminProductsFn>>[number];

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
                    <b>{rand(Number(p.price_rand))}</b>{" "}
                    <Badge variant="outline">
                      {p.sale_online_only ? "Sale · online only" : "Sale"}
                    </Badge>
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
      {canEdit && (
        <ProductEditDialog
          products={products}
          editingProduct={editingProduct}
          setEditingProduct={setEditingProduct}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}
